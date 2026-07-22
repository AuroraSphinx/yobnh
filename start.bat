@echo off
echo Starting YOBNH...


npx ts-node index.ts
set NODE_OPTIONS=--disable-warning=DEP0190
pause