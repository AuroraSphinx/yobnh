try {
  require("./dist/index.js");
} catch (error) {
  console.error("Failed to load compiled bot.");
  console.error("Run 'npm run build' first, then 'npm start'.");
  console.error(error);
  process.exit(1);
}
