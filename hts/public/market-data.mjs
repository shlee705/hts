// Frozen reference universe. No runtime requests to quote providers.
export const MARKET_DATA = Object.freeze({
  "sharesAsOf": "2026-11-18",
  "asOf": "2026-11-18",
  "observedAt": "2026-11-18 15:30 KST",
  "checkedOn": "2026-11-18",
  "indexClose": 1000,
  "indexCode": "KPI10",
  "indexName": "KOSPI 10"
});
export const STOCKS = Object.freeze([
  {"code":"005930","name":"삼성전자","shares":5718609206,"rank":1,"close":194700,"market":"KOSPI"},
  {"code":"000660","name":"SK하이닉스","shares":711116231,"rank":2,"close":1144000,"market":"KOSPI"},
  {"code":"005380","name":"현대차","shares":202418466,"rank":3,"close":267000,"market":"KOSPI"},
  {"code":"105560","name":"KB금융","shares":348346377,"rank":4,"close":156400,"market":"KOSPI"},
  {"code":"000270","name":"기아","shares":388656045,"rank":5,"close":92200,"market":"KOSPI"},
  {"code":"034020","name":"두산에너빌리티","shares":639132672,"rank":6,"close":43050,"market":"KOSPI"},
  {"code":"035420","name":"NAVER","shares":149888185,"rank":7,"close":170300,"market":"KOSPI"},
  {"code":"010140","name":"삼성중공업","shares":854035571,"rank":8,"close":15760,"market":"KOSPI"},
  {"code":"0126Z0","name":"삼성에피스홀딩스","shares":24836935,"rank":9,"close":362500,"market":"KOSPI"},
  {"code":"000150","name":"두산","shares":13604900,"rank":10,"close":588000,"market":"KOSPI"}
].map(Object.freeze));

export const referenceCap = STOCKS.reduce((sum, stock) => sum + stock.close * stock.shares, 0);
export const indexFromCap = cap => MARKET_DATA.indexClose * (cap / referenceCap);
