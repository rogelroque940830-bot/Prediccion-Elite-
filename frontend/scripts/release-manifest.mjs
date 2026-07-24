import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";
const root=process.cwd(), dist=path.join(root,"dist");
if(!fs.existsSync(dist)){console.error("dist missing");process.exit(2)}
const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)]);
const files=walk(dist).sort().map(p=>({path:path.relative(dist,p).replaceAll(path.sep,"/"),bytes:fs.statSync(p).size,sha256:crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")}));
const manifest={product:"Court Edge Web",version:"1.0.0-phase3-sprint2",generatedAt:new Date().toISOString(),gitCommit:process.env.GITHUB_SHA||null,apiBaseConfigured:Boolean(process.env.VITE_API_BASE_URL),files};
fs.writeFileSync(path.join(root,"RELEASE_MANIFEST.json"),JSON.stringify(manifest,null,2)+"\n");
console.log(`Wrote RELEASE_MANIFEST.json (${files.length} files)`);
