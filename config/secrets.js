// Loading secrets at run time.
//
// On a PC the secrets come from .env, which is in .gitignore.
// On Lambda the function's own settings hold only three plain values:
// SECRET_ID, CORS_ORIGINS and NODE_ENV. The Neon connection string and the
// Turnstile key are NOT there. They live in AWS Secrets Manager, encrypted
// with our own KMS key, and are fetched once when the function starts.
//
// Why bother, when Lambda environment variables are already encrypted at
// rest? Three reasons from Lecture 7:
//   1. Anyone who can read the function's configuration can read a plain
//      environment variable. Reading the secret needs a second permission
//      (secretsmanager:GetSecretValue) on that one secret, plus kms:Decrypt
//      on that one key.
//   2. The value can be rotated in one place without redeploying the code.
//   3. Every read is recorded, so there is a trail of who fetched it.

let loaded = false;

/**
 * Copy the secret's fields into process.env, once per container.
 *
 * Called at the start of the Lambda handler. It is safe to call again: the
 * second call returns immediately, so a warm container does not pay for
 * another network round trip.
 *
 * Nothing it reads is ever logged, printed or returned.
 */
async function loadSecrets() {
  if (loaded) return;
  const secretId = (process.env.SECRET_ID || '').trim();
  if (!secretId) {
    // Running on a PC: .env already supplied the values.
    loaded = true;
    return;
  }

  // Required inside the function, not at the top of the file, because the
  // AWS SDK ships with the Lambda runtime but is not installed locally.
  // A top-level require would break `npm run dev` on a laptop.
  const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

  const client = new SecretsManagerClient({});
  const response = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  const secret = JSON.parse(response.SecretString || '{}');

  // Only the keys we expect. A secret that grew an extra field cannot
  // quietly set something else in the environment.
  for (const key of ['DATABASE_URL', 'TURNSTILE_SECRET_KEY', 'INTERNAL_API_KEY']) {
    if (secret[key]) process.env[key] = secret[key];
  }

  loaded = true;
  console.log(
    JSON.stringify({ level: 'info', msg: 'secrets loaded', secret_id: secretId, keys: Object.keys(secret).length })
  );
}

module.exports = { loadSecrets };
