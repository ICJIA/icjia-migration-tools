// PM2 ecosystem config for Strapi 5
// Copy to the Strapi 5 project root on the server, then:
//   pm2 start ecosystem.config.cjs
//   pm2 save
//   pm2 startup
//
// Strapi reads APP_KEYS, JWT secrets, etc. from the .env file
// that was auto-generated during `npx create-strapi@latest`.
// No need to duplicate those values here.

module.exports = {
  apps: [
    {
      name: 'strapi5-researchhub',
      cwd: '/home/forge/v2.hub.icjia-api.cloud/v2hub',
      script: 'npm',
      args: 'start',
      env: {
        NODE_ENV: 'production',  // Use production mode — dev mode causes Vite host blocking behind Nginx
      },
      max_memory_restart: '512M',
      autorestart: true,
      watch: false,
    },
  ],
};
