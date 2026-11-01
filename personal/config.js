// 덕우 예산안 앱 설정. Apps Script 웹앱을 배포한 뒤 endpoint 에 URL 을 넣으면 첫 화면에서 다시 묻지 않는다.
window.LEDGER_CONFIG = {
  name: '덕우 예산안',
  endpoint: 'https://script.google.com/macros/s/AKfycbxQJ6rEvOk4nk8y2QM8wT3sZdkG_LjY5Y4VopGQdTpV53Lcq2j_-ZR3EFXBTUmlSjkx8A/exec',
  defaultUser: '',         // 이 기기 사용자의 이름(결제인). 비우면 앱 설정에서 입력
  localLedgerType: 'personal' // 체험 모드에서 쓰는 장부 유형
};
