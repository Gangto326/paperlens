import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    // 캐시 쓰기는 파일마다 fsync를 한다. 테스트 파일이 여럿 함께 돌면 요청을 여러 번 보내는 테스트가
    // 기본 5초에 가까워진다(따로 돌리면 1초 안팎). 단언은 그대로 두고 기다리는 시간만 늘린다.
    testTimeout: 20_000,
    // 기본값은 코어 수(이 노트북은 12)다. 전체 검사가 GROBID·Electron·빌드와 겹쳤을 때 노트북이 멈춘 적이 있어 줄인다.
    maxWorkers: 4,
  },
});
