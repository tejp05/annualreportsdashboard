# wxO Embed Server

Small Express server that signs JWTs for the watsonx Orchestrate embedded chat widget.

## 1 — Install dependencies

```bash
cd server
npm install
```

## 2 — Generate your RSA key pair

Run from the `server/` directory:

```bash
mkdir -p keys
ssh-keygen -t rsa -b 4096 -m PEM -f keys/example-jwtRS256.key -N ""
openssl rsa -in keys/example-jwtRS256.key -pubout -outform PEM -out keys/example-jwtRS256.key.pub
```

This creates:
- `keys/example-jwtRS256.key` — your **private** signing key (never commit this)
- `keys/example-jwtRS256.key.pub` — your public key (upload to Orchestrate)

## 3 — Upload your public key to Orchestrate

In the watsonx Orchestrate UI:
1. Go to **Channels → Webchat → Security**
2. Upload `keys/example-jwtRS256.key.pub` as your RSA public key
3. Download the **IBM public key** from that same page and save it as `keys/ibmPublic.key.pub`

## 4 — Start the server

```bash
npm start
```

Open **http://localhost:3000** — the dashboard loads and the AI Assistant tab will now authenticate properly.

## Security notes

- Never commit `keys/example-jwtRS256.key` — it's in `.gitignore`
- Use HTTPS + set `secure: true` on the cookie in production
- Shorten the JWT `expiresIn` to `"1h"` or less in production
