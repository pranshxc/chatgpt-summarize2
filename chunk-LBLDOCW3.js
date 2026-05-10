import{a as w,k as v,l as x,n as P,o as N}from"./chunk-XZOEFNRP.js";import{d as c,e as E,h}from"./chunk-W7D2TEGV.js";

async function safeJson(response){
  const ct=response.headers.get("content-type")||"";
  const text=await response.text();
  if(!text||!text.trim())return null;
  if(!ct.includes("application/json")){
    console.warn("[safeJson] Non-JSON response (content-type:",ct,") body:",text.slice(0,300));
    return{__rawHtml__:text.slice(0,300),__contentType__:ct}
  }
  try{return JSON.parse(text)}
  catch(e){console.error("[safeJson] JSON parse failed:",text.slice(0,300));throw new Error("Server returned invalid response")}
}

// ── Read status/token DIRECTLY from storage — no sendMessage ───────────────────
var f=c(E()); // browser polyfill

async function getDeepSeekStatus(){
  // Primary: read from storage (written by SW on every cookie change + startup)
  try{
    const stored=await f.default.storage.local.get(['_dsStatus']);
    const s=stored['_dsStatus'];
    if(s&&typeof s.loggedIn!=='undefined'){
      console.log('[DeepSeek UI] status from storage:',s);
      return{loggedIn:Boolean(s.loggedIn),cookieCount:Number(s.cookieCount)||0,error:null};
    }
  }catch(e){
    console.warn('[DeepSeek UI] storage read failed:',e);
  }
  // Fallback: sendMessage (first-run before SW has written to storage)
  return new Promise((resolve)=>{
    try{
      chrome.runtime.sendMessage({type:'GET_DEEPSEEK_STATUS'},response=>{
        if(chrome.runtime.lastError){
          console.warn('[DeepSeek UI] sendMessage fallback error:',chrome.runtime.lastError.message);
          resolve({loggedIn:false,cookieCount:0});
          return;
        }
        console.log('[DeepSeek UI] sendMessage fallback response:',response);
        if(!response) resolve({loggedIn:false,cookieCount:0});
        else resolve({loggedIn:Boolean(response.loggedIn),cookieCount:Number(response.cookieCount)||0,error:response.error||null});
      });
    }catch(e){
      console.warn('[DeepSeek UI] sendMessage fallback threw:',e);
      resolve({loggedIn:false,cookieCount:0});
    }
  });
}

async function getDeepSeekToken(){
  // Read directly from storage
  try{
    const stored=await f.default.storage.local.get(['deepseek-token']);
    if(stored['deepseek-token'])return stored['deepseek-token'];
  }catch(e){
    console.warn('[DeepSeek UI] token storage read failed:',e);
  }
  // Fallback: sendMessage
  return new Promise((resolve)=>{
    try{
      chrome.runtime.sendMessage({type:'GET_DEEPSEEK_TOKEN'},response=>{
        if(chrome.runtime.lastError){resolve(null);return;}
        resolve(response?.token||null);
      });
    }catch(e){resolve(null);}
  });
}

function getDeepSeekCookies(){
  return new Promise((resolve)=>{
    try{
      chrome.runtime.sendMessage({type:'GET_DEEPSEEK_COOKIES'},response=>{
        if(chrome.runtime.lastError){resolve(null);return;}
        resolve(response?.cookieStr||null);
      });
    }catch(e){resolve(null);}
  });
}

async function C(e,t){
  if(!t)throw new Error("No token provided");
  let r=await fetch(e,{headers:{Authorization:`Bearer ${t}`}}),n=await safeJson(r);
  if(!r.ok)throw new Error(n?.detail?.message||"Unknown Error");
  return n
}

function p(e,t,r){
  return v(t&&e?t:null,async o=>{
    if(o==="local")return r([]);
    let d=await C(o,e||"");
    return r(d)
  },{shouldRetryOnError:!0})
}

function R(e,t){let r=N.getConfig(t);return p(e,e?r.modelsUrl:null,r.mapModelsResponse)}

var a=c(E()),m=c(w());
var s=c(h());

async function getToken(){
  return await getDeepSeekToken();
}

function D({onLoginStatusChange:e,callback:t}){
  const[status,setStatus]=(0,a.useState)(null);
  const[checking,setChecking]=(0,a.useState)(false);
  const[tokenInfo,setTokenInfo]=(0,a.useState)(null);

  const checkStatus=(0,a.useCallback)(async()=>{
    setChecking(true);
    try{
      const st=await getDeepSeekStatus();
      console.log('[DeepSeek UI] checkStatus:',st);
      setStatus(st);
      if(st&&st.loggedIn){
        const token=await getToken();
        if(token){
          setTokenInfo({found:true,preview:token.slice(0,12)+'...'});
          e&&e(true);
          t&&t();
        }else{
          setTokenInfo({found:false,hint:'Open chat.deepseek.com to let the extension read your token.'});
          e&&e(true);
        }
      }else{
        setTokenInfo(null);
        e&&e(false);
      }
    }catch(err){
      console.error('[DeepSeek] checkStatus error:',err);
      setStatus({loggedIn:false,cookieCount:0,error:err?.message});
      e&&e(false);
    }finally{
      setChecking(false);
    }
  },[e,t]);

  // Auto-check on mount
  (0,a.useEffect)(()=>{checkStatus();},[]);

  // ← NEW: also watch storage for real-time updates (cookie change → SW writes → UI reacts)
  (0,a.useEffect)(()=>{
    function onStorageChange(changes,area){
      if(area!=='local')return;
      if(changes['_dsStatus']){
        const s=changes['_dsStatus'].newValue;
        if(s&&typeof s.loggedIn!=='undefined'){
          const next={loggedIn:Boolean(s.loggedIn),cookieCount:Number(s.cookieCount)||0,error:null};
          console.log('[DeepSeek UI] storage update detected:',next);
          setStatus(next);
          if(next.loggedIn){e&&e(true);}else{setTokenInfo(null);e&&e(false);}
        }
      }
    }
    try{chrome.storage.onChanged.addListener(onStorageChange);}catch{}
    return()=>{
      try{chrome.storage.onChanged.removeListener(onStorageChange);}catch{}
    };
  },[e]);

  const handleDisconnect=(0,a.useCallback)(async()=>{
    try{await f.default.storage.local.remove(['deepseek-token','deepseek-login','deepseek-password','_dsStatus']);}catch{}
    setStatus({loggedIn:false,cookieCount:0});
    setTokenInfo(null);
    e&&e(false);
  },[e]);

  if(status===null){
    return(0,s.jsxs)("div",{className:"flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400",
      children:[(0,s.jsx)(x,{style:"h-4 w-4"})," Checking DeepSeek session\u2026"]})
  }

  if(status.loggedIn){
    return(0,s.jsxs)("div",{className:"flex flex-col gap-3 text-sm",children:[
      (0,s.jsxs)("div",{className:"flex items-center gap-2 rounded-md bg-green-50 dark:bg-green-900/30 px-3 py-2 text-green-700 dark:text-green-400",children:[
        (0,s.jsx)("span",{className:"inline-block h-2.5 w-2.5 rounded-full bg-green-500 flex-shrink-0"}),
        (0,s.jsxs)("span",{children:["Connected",status.cookieCount>0?` (${status.cookieCount} cookie${status.cookieCount!==1?'s':''})`:"",
          tokenInfo?.found?(0,s.jsxs)("span",{className:"ml-1 text-green-600 dark:text-green-300",children:[" \u2022 token ",tokenInfo.preview]}):null
        ]})
      ]}),
      !tokenInfo?.found&&(0,s.jsxs)("p",{className:"text-xs text-amber-600 dark:text-amber-400",
        children:["\u26a0\ufe0f ",tokenInfo?.hint||"Open ",
          (0,s.jsx)("a",{href:"https://chat.deepseek.com",target:"_blank",rel:"noopener noreferrer",className:"underline",children:"chat.deepseek.com"}),
          " and keep a tab open so the extension can read your session token."
        ]}),
      (0,s.jsx)("p",{className:"text-xs text-gray-500 dark:text-gray-400",children:"Your DeepSeek browser session is used automatically. No login required."}),
      (0,s.jsxs)("div",{className:"flex items-center gap-2",children:[
        (0,s.jsx)("button",{type:"button",onClick:checkStatus,disabled:checking,
          className:"items-center rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-200 shadow-sm hover:bg-gray-50 disabled:opacity-50",
          children:checking?(0,s.jsx)(x,{style:"h-3.5 w-3.5"}):"\u21bb Refresh"}),
        (0,s.jsx)("button",{type:"button",onClick:handleDisconnect,
          className:"items-center rounded-md border border-transparent bg-red-500 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-red-700",
          children:"Disconnect"})
      ]})
    ]})
  }

  return(0,s.jsxs)("div",{className:"flex flex-col gap-3 text-sm",children:[
    (0,s.jsxs)("div",{className:"flex items-center gap-2 rounded-md bg-orange-50 dark:bg-orange-900/30 px-3 py-2 text-orange-700 dark:text-orange-400",children:[
      (0,s.jsx)("span",{className:"inline-block h-2.5 w-2.5 rounded-full bg-orange-400 flex-shrink-0"}),
      (0,s.jsx)("span",{children:"Not connected to DeepSeek"})
    ]}),
    (0,s.jsxs)("p",{className:"text-xs text-gray-500 dark:text-gray-400",children:[
      "Log in at ",
      (0,s.jsx)("a",{href:"https://chat.deepseek.com",target:"_blank",rel:"noopener noreferrer",
        className:"text-primary-600 underline hover:text-primary-800",children:"chat.deepseek.com"}),
      " in your browser. The extension will detect your session automatically."
    ]}),
    status.error&&(0,s.jsx)("p",{className:"text-xs text-red-500",children:status.error}),
    (0,s.jsx)("div",{className:"flex items-center justify-end",children:
      (0,s.jsx)("button",{type:"button",onClick:checkStatus,disabled:checking,
        className:"items-center rounded-md border border-transparent bg-primary-500 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 disabled:opacity-50",
        children:checking?(0,s.jsx)(x,{style:"flex h-5 w-5 items-center justify-center"}):"Check Login Status"})
    })
  ]})
}

var J=D;
export{R as a,J as b};
