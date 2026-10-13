import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'chat.aircrew.go',
  appName: 'Aircrew Go',
  webDir: 'dist',
  // Every TDLib update crosses the bridge as an event: bridge logging would print each one.
  loggingBehavior: 'none',
  android: { backgroundColor: '#0f1115' },
};

export default config;
