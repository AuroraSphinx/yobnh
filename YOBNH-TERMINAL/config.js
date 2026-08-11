module.exports = {
  // The terminal connects to the bot's VPS over SSH to show the tmux session.
  // When the terminal runs ON the bot's VPS, keep host as 'localhost'.
  host: process.env.SSH_HOST || 'localhost',
  port: Number(process.env.SSH_PORT || 22),
  username: process.env.SSH_USER || 'root',

  auth: process.env.SSH_AUTH || 'password', // 'password' or 'key'
  // Set SSH_PASSWORD to the VPS root password (never commit it here).
  password: process.env.SSH_PASSWORD || '',
  key: (process.env.SSH_KEY || '').replace(/\\n/g, '\n'),

  tmuxSession: process.env.TMUX_SESSION || 'bot', // set to null for a plain shell

  // Basic auth for the web page (admin panel login).
  authUser: process.env.AUTH_USER || 'admin',
  authPass: process.env.AUTH_PASS || 'yobnh'
};
