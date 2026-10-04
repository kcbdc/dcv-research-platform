# DCV Research Platform v0.9.0

## Research invite login
- 1회용 연구 초대코드를 참가자 로그인 자격증명으로 사용하도록 추가했습니다.
- `POST /api/human-login` 및 프로젝트 범위 `POST /api/projects/:id/reviewer-login`을 지원합니다.
- 최초 로그인 시 초대코드가 서버 생성 참가자 ID와 요청 fingerprint에 결속됩니다.
- 이해확인 통과 후 같은 초대코드로 재접속하면 기존 인간실험 세션을 안전하게 재개할 수 있습니다.
- 관리자 토큰 없이 참가자 모드만 사용할 수 있으며 관리자 API 권한은 부여하지 않습니다.
- 관리자 화면에서 1회용 초대코드를 발급·복사할 수 있습니다.
- API는 최대 50개의 초대코드 일괄 발급을 지원합니다 (`count`, `subject_prefix`).

## Mobile UI / UX stabilization
- 모바일 프로젝트 상세 action bar를 2열 grid로 재배치하고 버튼 내 한글 세로 쪼개짐을 차단했습니다.
- FDIC ranking, External Validation Matrix, Workbench 표는 좁은 화면에서 열 폭을 압축하지 않고 가로 스크롤하도록 변경했습니다.
- diagnostic/preformatted text는 카드 폭 안에서 안전하게 줄바꿈됩니다.
- External Matrix 상태 badge의 원형 왜곡을 제거했습니다.
- 참가자 전용 화면을 별도 제공해 관리 연구 화면과 혼합되지 않게 했습니다.
- static asset cache-buster를 v0.9.0으로 갱신하여 이전 CSS/JS 캐시 혼용을 방지합니다.

## Verification
- `npm test`: 212 / 212 PASS
- participant invite-login resume test PASS
- bulk invite issuance test PASS
