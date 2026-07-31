import fs from "node:fs";

const file = "frontend/client/src/lib/wnba-shadow-emission.ts";
let content = fs.readFileSync(file, "utf8");
const from = `  const candidates = [...document.querySelectorAll<HTMLInputElement>('input[type="date"]')];`;
const to = `  const candidates = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="date"]'));`;
const count = content.split(from).length - 1;
if (count !== 1) throw new Error(`expected one NodeList iteration sentinel, found ${count}`);
content = content.replace(from, to);
fs.writeFileSync(file, content, "utf8");
