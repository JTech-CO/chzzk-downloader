# MaCode

> **세련된 Mac 테마 UI에서 코드가 타이핑되는 애니메이션을 고화질 영상으로 추출하세요.**

## 1. 소개 (Introduction)

이 프로젝트는 소스코드나 개발 튜토리얼 등을 Mac 윈도우 스타일로 렌더링하고, 이를 영상 콘텐츠로 제작하기 위해 개발된 웹 애플리케이션입니다. macOS Sequoia 스타일의 글래스모피즘(Glassmorphism) 설정 패널과 강력한 화면 크롭 녹화 기능을 제공합니다.

**주요 기능**
- **Mac 스타일 코드 윈도우**: 윈도우 컨트롤러와 다크 테마가 적용된 프리미엄 코드 렌더링 UI.
- **다이내믹 타이핑 애니메이션**: 실제 타이핑과 유사한 속도 조절 및 AI 청크(단어 단위) 모드 지원.
- **고화질 영상 렌더링**: Screen Capture API를 활용해 Mac 창 영역만 정밀하게 크롭하여 `.webm` 영상으로 저장.
- **글래스모피즘 디자인**: 반투명 효과와 딥 추상 그래디언트 배경이 적용된 선명한 디자인.
- **로컬 호환성**: 서버 없이 `index.html` 실행만으로 모든 기능을 즉시 사용 가능.

## 2. 기술 스택 (Tech Stack)

- **Frontend**: HTML5, Vanilla JavaScript, CSS3
- **CSS Framework**: Tailwind CSS (CDN Integration)
- **APIs**: Screen Capture API (getDisplayMedia), MediaStream Recording API (MediaRecorder)
- **Typography**: San Francisco (System Stack), Fira Code (Mono)

## 3. 설치 및 실행 (Quick Start)

이 프로젝트는 별도의 빌드 과정이나 로컬 서버 설정이 필요하지 않은 정적 웹 애플리케이션입니다.

1. **다운로드 (Download)**
   ```bash
   git clone https://github.com/JTech-CO/MaCode.git
   cd MaCode
   ```

2. **실행 (Run)**
   - `index.html` 파일을 브라우저(Chrome 권장)에서 더블 클릭하여 실행합니다.

3. **영상 렌더링 방법**
   - 소스 코드를 입력하고 언어와 속도를 설정합니다.
   - '렌더링 시작 (전체화면)' 버튼을 클릭합니다.
   - 브라우저의 화면 공유 팝업에서 **'현재 탭(MaCode)'**을 선택합니다.
   - 애니메이션이 완료되면 자동으로 영상 파일이 다운로드됩니다.

## 4. 폴더 구조 (Structure)

```text
MaCode/
├── css/
│   ├── base.css        # 전역 변수, 타이포그래피 설정
│   ├── layout.css      # 배경 그래디언트 및 글래스모피즘 레이아웃
│   └── components.css  # 버튼, 입력창, 구문 강조, 애니메이션 스타일
├── js/
│   ├── main.js         # 앱 초기화 및 UI 이벤트 핸들링
│   ├── editor.js       # 타이핑 엔진 및 구문 강조 로직
│   └── utils.js        # VideoRecorder 클래스 및 화면 보정 유틸리티
└── index.html          # 메인 HTML 구조
```

## 5. 정보 (Info)

- **License**: MIT License