# 수동 검증 도구

저장소 루트에서 개발 의존성을 설치한 뒤 실행합니다. 결과는 `test-results/`에 저장됩니다. 일반 빌드·패키징·테스트에서는 실행하지 않습니다.

- `node scripts/manual/compare-speed.cjs`: 2.2.6과 현재 소스의 합성 전송·UI 비교. 실제 CDN 속도 측정이 아닙니다.
- `node scripts/manual/validate-vod-fix.cjs`: 제보된 공개 채널의 VOD를 보존된 2.3.0과 현재 소스로 비교하고, 본편 2개에서 각각 64 KiB를 요청합니다. 네트워크를 사용하며 서명 URL이나 inKey를 결과에 저장하지 않습니다. 영상이 삭제되거나 재생 정보가 바뀌면 재현 조건이 달라질 수 있습니다.

기존 측정 결과는 [`docs/benchmarks/`](../../docs/benchmarks/)와 [`docs/validation/`](../../docs/validation/)에 보존합니다.
