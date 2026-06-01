module.exports = {
  apps: [{
    name:          'culpeper-dispatch',
    script:        './server/index.js',
    cwd:           '/Users/timothytoler/Desktop/culpeper-dispatch',
    watch:         false,
    restart_delay: 5000,
    max_restarts:  20,
    exp_backoff_restart_delay: 100,
    env: {
      NODE_ENV: 'production',
    },
  }],
};
