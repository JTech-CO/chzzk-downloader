# Chzzk Downloader

> **네이버 치지직(Chzzk)에서 VOD(다시보기) 및 클립을 원본 화질 MP4로 다운로드하는 Chrome 확장 프로그램입니다.**

## 1. 소개 (Introduction)

이 프로젝트는 네이버 치지직(Chzzk) 스트리머 채널의 동영상(VOD) 및 클립을 간편하게 다운로드할 수 있도록 돕는 비공식 확장 프로그램입니다. 
치지직 영상 탭으로 이동 시 화면 우측 하단에 생성되는 패널을 통해 직관적으로 영상을 다운로드하여 학습 및 백업을 위한 오프라인 환경에서 자유롭게 시청하는 가치를 제공합니다.

**주요 기능**
- **VOD & 클립 추출**: DASH MPD 스트리밍 XML을 파싱하여 세그먼트 파일을 병렬 다운로드 후, 하나의 고화질 MP4 파일로 자동 병합합니다. (직접 MP4 다운로드도 지원)
- **그리드 기반 패널 UI**: 현재 페이지의 영상을 감지하여 썸네일과 진행 상태바가 포함된 2열 그리드 리스트를 제공합니다.
- **개발자 디버그 모드 모니터링**: 실시간 API 호출 상태 흐름과 응답 에러를 즉각적으로 파악할 수 있는 로그 뷰어 시스템을 내장하고 있습니다.

**지원 콘텐츠 요약**
| 유형 | URL 패턴 | 다운로드 방식 | 출력 형식 |
|------|----------|-------------|----------|
| VOD (다시보기) | `/{channelId}/videos` | DASH MPD → 세그먼트 병렬 다운로드 병합 | MP4 |
| 클립 | `/{channelId}/clips` | DASH MPD → 세그먼트 병렬 다운로드 병합 | MP4 |

## 2. 기술 스택 (Tech Stack)

- **Frontend**: Vanilla JavaScript, CSS, HTML
- **Background Task Execution**: Chrome Extension Service Worker (Manifest V3)
- **APIs**: Fetch API, Chrome Downloads API
- **Data Engineering**: XML DOMParser, JavaScript Blob Data Merging

## 3. 기술 아키텍처 (Architecture)

```
Content Script (content.js)                    Background (background.js)
┌──────────────────────────────┐               ┌─────────────────────────┐
│ URL 감지 (SPA pushState 감시)│               │ DASH 세그먼트 병렬 다운로드 │
│ Chzzk API 호출 (쿠키 포함)   │ ──segments──▶ │  (6개 동시, Blob 병합)    │
│ DASH MPD XML 파서            │               │ HLS 세그먼트 다운로드     │
│ 패널 UI (2열 그리드)         │ ◀──progress── │ chrome.downloads API     │
│ 디버그 로그                  │               └─────────────────────────┘
└──────────────────────────────┘
```

Content Script에서 API를 호출하는 이유는 `chzzk.naver.com` 페이지 컨텍스트의 네이버 로그인 쿠키(`NID_AUT`, `NID_SES`)가 `fetch(..., { credentials: 'include' })`를 통해 자동으로 전달되어야 하기 때문입니다. Background Service Worker에서는 이 쿠키에 접근할 수 없습니다.

### VOD 다운로드 플로우

```
videoNo → /service/v2/videos/{videoNo} → videoId + inKey 획득
       → /neonplayer/vodplay/v2/playback/{videoId}?key={inKey}&sid=2099&env=real&lc=ko&cpl=ko
       → DASH MPD XML 응답
       → XML 파싱: AdaptationSet → 최고 bandwidth Representation 선택
       → BaseURL(직접 MP4) 또는 SegmentTemplate(세그먼트 목록) 추출
       → Background에서 세그먼트 6개씩 병렬 다운로드 → Blob 병합 → MP4 저장
```

### 클립 다운로드 플로우

```
clipId → /service/v1/play-info/clip/{clipId} → videoId + inKey 획득
       → VOD와 동일한 neonplayer 호출
       → DASH MPD XML → 파싱 → 다운로드
```

### API 엔드포인트

| 용도 | URL |
|------|-----|
| 영상 목록 | `api.chzzk.naver.com/service/v1/channels/{channelId}/videos` |
| 클립 목록 | `api.chzzk.naver.com/service/v1/channels/{channelId}/clips` |
| 영상 상세 | `api.chzzk.naver.com/service/v2/videos/{videoNo}` |
| 클립 상세 | `api.chzzk.naver.com/service/v1/play-info/clip/{clipId}` |
| 재생 정보 | `apis.naver.com/neonplayer/vodplay/v2/playback/{videoId}?key={inKey}&sid=2099&env=real&lc=ko&cpl=ko` |

### neonplayer 응답 형식

neonplayer API는 JSON이 아닌 **DASH MPD(XML)** 을 반환합니다. 
`?sid=2099&env=real&lc=ko&cpl=ko` 파라미터는 필수이며, 생략 시 400 에러가 발생합니다.

### DASH MPD 파싱 전략

1. `AdaptationSet` 중 `mimeType`이 `video/*`인 것을 선택
2. `Representation` 중 `bandwidth`가 가장 높은 것을 선택 (원본 화질)
3. `BaseURL`이 있으면 직접 MP4 URL로 처리
4. `SegmentTemplate`이 있으면 `initialization` + `media` 패턴에서 세그먼트 URL 배열을 생성

## 4. 설치 및 실행 (Quick Start)

**요구 사항**: Chrome 또는 Chromium 기반(Whale 등) 브라우저

1. **설치 (Install)**
   - 최신 `chzzk-downloader.zip` 파일을 다운로드하고 압축을 해제합니다.
   - 브라우저에서 `chrome://extensions` (확장 프로그램 관리) 페이지로 이동합니다.
   - 우측 상단 모서리에 있는 **개발자 모드** 토글을 켭니다.
   - 좌측 상단의 **[압축 해제된 확장 프로그램을 로드합니다]** 아이콘을 클릭하고, 방금 전 압축 해제한 폴더를 선택하여 확장을 등록합니다. (동일 확장 프로그램의 구 버전이 존재한다면 먼저 지운 후 설치해주세요)

2. **실행 (Run)**
   - 웹 브라우저에서 [치지직](https://chzzk.naver.com/)에 접속하여 본인의 계정으로 **로그인**합니다.
   - 다운로드받고자 하는 스트리머의 채널에서 **동영상** 또는 **클립** 탭으로 진입합니다.
   - 화면 우측 하단의 초록색 다운로드 스크롤러 아이콘(⬇)을 클릭해 패널 창을 엽니다.
   - 표시되는 영상 목록 중 원하는 카드를 클릭하면 그 즉시 다운로드 파싱이 시작됩니다.

## 5. 폴더 구조 (Structure)

```text
chzzk-downloader/
├── manifest.json       # Chrome Manifest 권한 및 스크립트 연결 설정 파일 (버전 관리)
├── content.js          # API 호출(DOM 의존), 다운로더 UI 렌더링, 응답 처리 로직
├── content.css         # 확장 프로그램의 다운로더 패널(2열 구조)을 꾸미는 스타일시트
├── background.js       # Blob/DASH 세그먼트 파일 병렬 제어 및 백그라운드 다운로드 로직 수행
└── icons/              # 브라우저 UI 및 관리에 표시되는 로고 이미지 애셋 폴더
```

## 6. 정보 (Info)

- **Version**: `v2.1.2`
- **Technical Updates (v2.1.2)**:
  - **파일명 특수문자 처리 개선**: `sanitize()` 함수 로직 개선 — Windows 금지 특수문자(`\`, `/`, `:`, `*`, `?`, `"`, `<`, `>`, `|`) 및 제어 문자(ASCII 0–31, 127)를 `_`로 대체하지 않고 완전히 제거하도록 변경. 앞뒤 점(`.`) 제거, 모든 문자 제거 시 `chzzk` 기본값 반환
- **Technical Updates (v2.1.1)**:
  - **UI 안정성 고도화**: Universal Reset(box-sizing) 및 Z-index 최적화로 사이트 간섭 최소화
  - **폰트 시스템 개선**: JSDelivr CDN 기반 Pretendard 가변 폰트 적용으로 로딩 신뢰성 확보
  - **표준 호환성**: 최신 CSS 표준 `line-clamp` 속성 도입으로 브라우저 호환성 강화
- **Notice**:
  - 시스템 특성상 인증(성인 인증, 맴버십 인증 등)이 요구되는 콘텐츠는 사용자가 브라우저상에서 치지직 로그인 및 조건 충족을 완료한 상태에서 진행해야 정상 동작합니다.
  - Naver 및 Chzzk의 비공식 API로 구동되므로 통신 프로토콜 변경에 의해 예고 없이 다운로드가 차단될 수 있습니다.
  - 사용자 본인의 VOD 백업 및 개인용 학습 목적으로만 활용하십시오.
- **Privacy Policy**: [개인정보 처리방침 안내](<https://jtech-co.github.io/chzzk-downloader/privacy-policy.html>)
