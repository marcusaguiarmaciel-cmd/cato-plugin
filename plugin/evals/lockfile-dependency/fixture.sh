#!/usr/bin/env bash
set -e
git init -q .
printf 'node_modules/\n' > .gitignore
cat > package.json <<'J'
{ "name": "fixture", "version": "1.0.0", "dependencies": { "left-pad": "^1.3.0", "chalk": "^5.3.0" } }
J
node -e '
const p={};for(let i=0;i<1500;i++)p["node_modules/pkg-"+i]={version:"1.0."+i,resolved:"https://registry.npmjs.org/pkg-"+i+"/-/pkg-"+i+"-1.0."+i+".tgz",integrity:"sha512-"+"a".repeat(80)};
p["node_modules/left-pad"]={version:"1.3.0"};
require("fs").writeFileSync("package-lock.json",JSON.stringify({name:"fixture",lockfileVersion:3,packages:p},null,2))'
