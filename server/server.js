const fs = require("fs");
const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");
const { v4: uuid } = require("uuid");
const jwtLib = require("jsonwebtoken");
const NodeRSA = require("node-rsa");

const app = express();
const PORT = process.env.PORT || 3000;

// ── Key loading ──────────────────────────────────────────────────────────────
const PRIVATE_KEY_PATH = path.join(__dirname, "keys/myrsakey");
const IBM_PUBLIC_KEY_PATH = path.join(__dirname, "keys/ibmpublickey");

if (!fs.existsSync(PRIVATE_KEY_PATH)) {
  console.error("ERROR: Private key not found at", PRIVATE_KEY_PATH);
  console.error("Run the keygen commands in README.md first.");
  process.exit(1);
}
if (!fs.existsSync(IBM_PUBLIC_KEY_PATH)) {
  console.error("ERROR: IBM public key not found at", IBM_PUBLIC_KEY_PATH);
  console.error("Run the fetch-ibm-key script in README.md first.");
  process.exit(1);
}

const PRIVATE_KEY = fs.readFileSync(PRIVATE_KEY_PATH);
const IBM_PUBLIC_KEY = fs.readFileSync(IBM_PUBLIC_KEY_PATH);

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(cookieParser());

// Serve the website static files
app.use(express.static(path.join(__dirname, "..")));  // site lives at the repo root

// ── JWT helpers ──────────────────────────────────────────────────────────────
function createJWTString(anonymousUserID) {
  const jwtContent = {
    sub: anonymousUserID,
    user_payload: {
      name: "Anonymous",
      custom_message: "",
      custom_user_id: anonymousUserID,
      sso_token: "",
    },
    context: {
      name: "User",
    },
  };

  // Encrypt user_payload with IBM's public key
  const rsaKey = new NodeRSA(IBM_PUBLIC_KEY, "public");
  const dataString = JSON.stringify(jwtContent.user_payload);
  jwtContent.user_payload = rsaKey.encrypt(Buffer.from(dataString, "utf-8"), "base64");

  return jwtLib.sign(jwtContent, PRIVATE_KEY, {
    algorithm: "RS256",
    expiresIn: "1h",
  });
}

function getOrSetAnonymousID(req, res) {
  let id = req.cookies["ANONYMOUS-USER-ID"];
  if (!id) {
    id = `anon-${uuid()}`;
  }
  res.cookie("ANONYMOUS-USER-ID", id, {
    maxAge: 45 * 24 * 60 * 60 * 1000, // 45 days
    httpOnly: true,
    sameSite: "Lax",
    secure: false, // set true in production with HTTPS
  });
  return id;
}

// ── Routes ───────────────────────────────────────────────────────────────────

// JWT endpoint called by the browser before initialising the chat widget
app.get("/api/jwt", (req, res) => {
  const anonymousUserID = getOrSetAnonymousID(req, res);
  const token = createJWTString(anonymousUserID);
  res.type("text/plain").send(token);
});


// Live market quote proxy for the Overview widget (avoids browser CORS limits)
app.get("/api/quote", async (req, res) => {
  const symbol = encodeURIComponent(req.query.symbol || "IBM");
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=5d`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) throw new Error(`upstream HTTP ${r.status}`);
    const j = await r.json();
    const result = j.chart.result[0];
    const meta = result.meta;
    // meta.chartPreviousClose/previousClose can be stale on this endpoint
    // (returns a value from well before the requested range). The response's
    // own daily closes array is accurate -- the second-to-last close is
    // yesterday's, since the last entry matches regularMarketPrice.
    const closes = (result.indicators?.quote?.[0]?.close || []).filter(c => c != null);
    const prevClose = closes.length >= 2 ? closes[closes.length - 2]
      : (meta.chartPreviousClose || meta.previousClose);
    res.json({
      symbol: req.query.symbol || "IBM",
      price: meta.regularMarketPrice,
      prevClose,
      currency: meta.currency,
      asOf: meta.regularMarketTime
        ? new Date(meta.regularMarketTime * 1000).toLocaleDateString()
        : null,
    });
  } catch (e) {
    res.status(502).json({ error: `quote unavailable: ${e.message}` });
  }
});

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`wxO embed server running at http://localhost:${PORT}`);
  console.log(`Open http://localhost:${PORT} in your browser.`);
});
