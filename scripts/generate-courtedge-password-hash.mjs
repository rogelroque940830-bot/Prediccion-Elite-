#!/usr/bin/env node
import crypto from "node:crypto";

const password = process.argv[2] || process.env.COURTEDGE_PASSWORD;
if (!password || password.length < 12) {
  console.error("Usage: node scripts/generate-courtedge-password-hash.mjs 'a-password-with-12-or-more-characters'");
  process.exit(1);
}

const salt = crypto.randomBytes(16);
const hash = crypto.scryptSync(password, salt, 64);
process.stdout.write(`scrypt$${salt.toString("hex")}$${hash.toString("hex")}\n`);
