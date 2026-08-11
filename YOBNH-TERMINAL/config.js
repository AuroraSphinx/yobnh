module.exports = {
  host: 'YOUR_VPS_IP',
  port: 22,
  username: 'root',

  auth: 'password', // 'password' or 'key'
  password: 'YOUR_PASSWORD',
  key: `-----BEGIN OPENSSH PRIVATE KEY-----
your key here
-----END OPENSSH PRIVATE KEY-----`,

  tmuxSession: 'bot', // set to null for a plain shell

  authUser: 'admin',
  authPass: 'yobnh'
};
