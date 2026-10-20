import { hostname } from 'node:os';
import { CliError } from './errors.js';

export async function register(client, email) {
  const credentials = await client.store.read('credentials', { version: 1, profiles: {} });
  const existing = credentials.profiles?.[client.authUrl]?.api_key;
  if (existing) {
    await client.token(); // Check the saved API/issuer pairing before reusing it.
    if (!/^dwb_[a-f0-9]{64}$/.test(existing)) throw new CliError('invalid_credentials', 'Saved issuer key is invalid; do not substitute a mock key.');
    client.secrets.add(existing);
    try {
      const identity = await client.identity(existing);
      if (email && email.toLowerCase() !== identity.account_email?.toLowerCase()) {
        throw new CliError('account_mismatch', 'Already signed in as a different account. Use a separate DATAWEBOT_CONFIG_DIR to connect another account.');
      }
      return { signed_in: true, account_email: identity.account_email, reused: true };
    } catch (error) {
      // Only an issuer 401 permits another approval request, not Jobs denial or network errors.
      if (error.details?.http_status !== 401) throw error;
    }
  }
  const identity = client.authUrl + '|datawebot CLI|' + hostname();
  let pending = await client.store.read('device-pending.json');
  let saved = pending[identity];
  if (saved?.deadline > Date.now() / 1000) {
    if (email && email.toLowerCase() !== saved.email?.toLowerCase()) {
      throw new CliError('account_mismatch', 'A different account has a pending sign-in. Resume it or use a separate DATAWEBOT_CONFIG_DIR.');
    }
    client.log('Resuming existing sign-in; no new email sent.', true);
  } else {
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      throw new CliError('invalid_email', 'Provide your email: dtwb register <email>. No approval email sent.');
    }
    await client.store.checkDirectory(true);
    const { data: code } = await client.request('/v1/device/code', { auth: true,
      body: { email, client_name: 'datawebot CLI', host_label: hostname() },
    });
    if (typeof code?.device_code === 'string') client.secrets.add(code.device_code);
    if (!/^[a-f0-9]{64}$/.test(code?.device_code) || typeof code.user_code !== 'string' ||
        typeof code.verification_uri !== 'string' || !Number.isFinite(code.expires_in) || code.expires_in <= 0 ||
        !Number.isFinite(code.interval) || code.interval <= 0) {
      throw new CliError('invalid_response', 'Invalid sign-in challenge; email may have been sent. Do not automatically register again.');
    }
    saved = { code, email, deadline: Date.now() / 1000 + code.expires_in, api_url: client.apiUrl };
    pending[identity] = saved;
    await client.store.write('device-pending.json', pending);
  }
  if (saved.api_url && saved.api_url !== client.apiUrl) {
    throw new CliError('credential_origin_mismatch', 'Pending sign-in belongs to a different API origin; resume with the original --api-url.');
  }
  const { code } = saved;
  client.secrets.add(code.device_code);
  client.log('Code: ' + code.user_code + '. Check the approval email for ' + saved.email +
    ', or approve at ' + code.verification_uri + '. Opening the email alone does not approve.', true);
  let interval = Math.max(5, code.interval);
  while (Date.now() / 1000 < saved.deadline) {
    await client.wait(Math.min(interval * 1000, saved.deadline * 1000 - Date.now()));
    if (Date.now() / 1000 >= saved.deadline) break;
    let token;
    try {
      ({ data: token } = await client.request('/v1/device/token', { auth: true,
        body: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: code.device_code },
      }));
    } catch (error) {
      if (error.code === 'authorization_pending') continue;
      if (error.code === 'slow_down') { interval += 5; continue; }
      // A token is delivered once; a lost response must not trigger another approval email.
      throw error;
    }
    if (typeof token?.api_key === 'string') client.secrets.add(token.api_key);
    if (!/^dwb_[a-f0-9]{64}$/.test(token?.api_key)) {
      throw new CliError('invalid_response', 'Issuer did not return a valid key. No automatic sign-in restart.');
    }
    const latest = await client.store.read('credentials', { version: 1, profiles: {} });
    latest.profiles = { ...latest.profiles, [client.authUrl]: { api_key: token.api_key, api_url: client.apiUrl } };
    await client.store.write('credentials', latest);
    pending = await client.store.read('device-pending.json');
    delete pending[identity];
    await client.store.write('device-pending.json', pending);
    return { signed_in: true, account_email: token.account_email, reused: false };
  }
  throw new CliError('expired_token', 'Approval expired. Run dtwb register <email> again.');
}
