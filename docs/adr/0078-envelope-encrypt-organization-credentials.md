# Envelope-encrypt Organization credentials

Each Organization receives a random data-encryption key used with authenticated encryption to protect Google refresh tokens, LINE channel secrets and access tokens, and AI provider credentials before storage in its Organization D1 database.

The Organization key is itself wrapped by a versioned deployment master key held as a Worker Secret. Ciphertext records retain the required key version and encryption metadata. Master-key rotation rewraps Organization keys without requiring every provider credential to be exposed and re-encrypted at once.
