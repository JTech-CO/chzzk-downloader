# Chzzk Downloader

> **네이버 치지직(Chzzk)의 VOD(다시보기)와 클립을 원본 화질 MP4로 다운로드하는 Chrome 확장 프로그램입니다.**

<p align="center">
  <img src="https://raw.githubusercontent.com/JTech-CO/chzzk-downloader/refs/heads/main/image/1-Main.png" alt="Chzzk Downloader 메인 화면" width="32%">
  <img src="https://raw.githubusercontent.com/JTech-CO/chzzk-downloader/refs/heads/main/image/2-Sub1.png" alt="Chzzk Downloader 목록 화면" width="32%">
  <img src="https://raw.githubusercontent.com/JTech-CO/chzzk-downloader/refs/heads/main/image/3-Sub2.png" alt="Chzzk Downloader 다운로드 화면" width="32%">
</p>

**이미지는 `v2.2.0` 기준이며, 최신 버전은 `v2.2.6`입니다.**

## 주요 기능

- **원본 화질 다운로드**: VOD와 클립의 직접 MP4 또는 DASH/HLS 조각을 최고 화질로 저장합니다. 재인코딩하지 않아 원본 화질을 유지합니다.
- **빠르고 안정적인 장시간 VOD 다운로드**: 256 MiB 이상의 직접 MP4는 16 MiB 단위로 최대 8개씩 병렬 다운로드하고 OPFS에 순차 기록합니다. 일시 오류를 재시도하며 10~12시간급 영상도 길이 때문에 중단하지 않습니다.
- **재생 호환성 보정**: HLS/fMP4의 초기화 세그먼트와 재생 시간·타임라인·64비트 탐색 인덱스를 보정해 `inKey` 유무와 관계없이 macOS, Windows Media Player, 팟플레이어에서 재생과 탐색이 가능하도록 처리합니다.
- **전체 목록과 정렬**: 16개/24개 이후의 항목까지 모두 불러오며 최신순(기본값), 과거순, 인기순 정렬을 지원합니다.
- **페이지별 UI 표시**: 다운로드 아이콘은 동영상(`videos`)과 클립(`clips`) 페이지에만 표시하고 라이브(`live`) 페이지에서는 숨깁니다.
- **진행 상태와 로그**: 다운로드 진행률, 빠른/느린 다운로드 방식, API 및 오류 로그를 패널에서 확인하고 복사할 수 있습니다.

| 콘텐츠 | URL | 다운로드 방식 | 결과 |
|---|---|---|---|
| VOD | `/{channelId}/videos` | 직접 MP4 병렬 `Range` 또는 HLS/fMP4 병합 | MP4 |
| 클립 | `/{channelId}/clips` | 직접 MP4 또는 DASH 병합 | MP4 |

## 동작 방식

```text
동영상/클립 목록 조회 및 정렬
  → 선택한 콘텐츠의 최고 화질 재생 정보 확인
  → 직접 MP4: 원본 파일 다운로드 또는 병렬 Range + OPFS
  → DASH/HLS: 초기화 조각과 미디어 조각 병렬 다운로드 및 병합
  → Chrome Downloads API로 MP4 저장
```

256 MiB 이상의 직접 MP4는 서버의 `Range` 지원과 전체 크기를 확인한 뒤 16 MiB 구간을 최대 8개씩 병렬로 받습니다. 각 응답의 범위, 크기, 파일 식별자를 검증하고 실패 시 재시도합니다. `Range`나 OPFS를 사용할 수 없거나 파일이 작은 경우에는 기존 단일 다운로드 방식으로 자동 전환합니다.

직접 MP4는 서버 원본 바이트를 그대로 저장합니다. HLS/fMP4는 초기화 세그먼트와 원본 영상 조각을 병합하고 필요한 재생 메타데이터만 보정합니다. 모든 처리는 사용자의 브라우저에서 치지직 공식 API와 지정된 미디어 CDN을 통해 이루어지며 개발자 서버를 거치지 않습니다.

## 설치 및 사용

**지원 브라우저**: Chrome, Whale 등 Chromium 기반 브라우저

1. 최신 `chzzk-downloader.zip`을 다운로드하고 압축을 해제합니다.
2. `chrome://extensions`에서 **개발자 모드**를 켭니다.
3. **압축 해제된 확장 프로그램을 로드합니다**를 눌러 폴더를 선택합니다. 구 버전이 설치되어 있다면 먼저 제거합니다.
4. [치지직](https://chzzk.naver.com/)에 로그인하고 채널의 **동영상** 또는 **클립** 탭으로 이동합니다.
5. 오른쪽 아래의 다운로드 아이콘을 눌러 목록을 열고 원하는 영상을 선택합니다.

## 개발 및 검증

주요 파일:

- `content.js`: 목록 조회, UI, 다운로드 계획 생성
- `background.js`: 직접 MP4, Range, HLS/DASH 다운로드와 MP4 완성
- `offscreen.js`: OPFS 파일의 임시 다운로드 URL 생성
- `legacy/v2.2.5/`: v2.2.5 전체 보존본

```powershell
node --check background.js
node --check content.js
node tests/range-download.test.js
powershell -ExecutionPolicy Bypass -File .\package.ps1
```

## 안내

- **버전**: `v2.2.6`
- 성인·멤버십 콘텐츠는 치지직 로그인과 해당 인증이 필요합니다.
- 치지직의 비공식 API를 사용하므로 서비스 변경 시 동작하지 않을 수 있습니다.
- 라이브 다시보기용 외부 CDN은 치지직 공식 API가 지정한 두 호스트의 `/chzzk/` 경로만 허용합니다.
- 사용자 본인의 VOD 백업과 개인적인 학습·소장 목적으로만 사용해 주세요.
- [개인정보 처리방침](https://jtech-co.github.io/chzzk-downloader/privacy-policy.html)
