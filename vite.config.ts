import { defineConfig } from 'vitest/config'

export default defineConfig({
  // GitHub Pagesのリポジトリ名に依存しないよう相対パスにする。
  // PWA対応時のscope調整はPhase 5で行う。
  base: './',
  build: {
    target: 'es2023',
    sourcemap: false,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
})