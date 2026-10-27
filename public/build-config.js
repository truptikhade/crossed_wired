const fs = require("fs");

const url = process.env.API_BASE_URL;
if (!url) {
  throw new Error("API_BASE_URL is not set");
}

fs.writeFileSync(
  "config.js",
  `window.API_BASE_URL = ${JSON.stringify(url)};\n`,
);
console.log("Wrote config.js with API_BASE_URL =", url);
