{
  "include": ["server/**/*", "shared/**/*"],
  "exclude": ["node_modules", "dist"],
  "compilerOptions": {
    "module": "ESNext",
    "strict": false,
    "lib": ["esnext", "dom"],
    "esModuleInterop": true,
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "types": ["node"],
    "baseUrl": ".",
    "paths": {
      "@shared/*": ["./shared/*"]
    },
    "outDir": "dist",
    "noEmit": true
  }
}
