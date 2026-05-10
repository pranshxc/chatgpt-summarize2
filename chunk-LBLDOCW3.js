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

// ── Cookie helpers (must go through background SW — chrome.cookies not available in popup) ──
function getDeepSeekCookies(){
  return new Promise(resolve=>{
    try{
      chrome.runtime.sendMessage({type:"GET_DEEPSEEK_COOKIES"},response=>{
        if(chrome.runtime.lastError){
          console.warn("[DeepSeek] sendMessage error:",chrome.runtime.lastError.message);
          resolve(null);
          return;
        }
        resolve(response?.cookieStr||null);
      });
    }catch(e){
      console.warn("[DeepSeek] getDeepSeekCookies failed:",e);
      resolve(null);
    }
  });
}

// Returns { loggedIn, cookieCount, allCookieNames }
function getDeepSeekStatus(){
  return new Promise(resolve=>{
    try{
      chrome.runtime.sendMessage({type:"GET_DEEPSEEK_STATUS"},response=>{
        if(chrome.runtime.lastError){
          console.warn("[DeepSeek] GET_DEEPSEEK_STATUS error:",chrome.runtime.lastError.message);
          resolve({loggedIn:false,cookieCount:0});
          return;
        }
        resolve(response||{loggedIn:false,cookieCount:0});
      });
    }catch(e){
      console.warn("[DeepSeek] getDeepSeekStatus failed:",e);
      resolve({loggedIn:false,cookieCount:0});
    }
  });
}

// Returns the bearer token from cookies/localStorage via background SW
function getDeepSeekToken(){
  return new Promise(resolve=>{
    try{
      chrome.runtime.sendMessage({type:"GET_DEEPSEEK_TOKEN"},response=>{
        if(chrome.runtime.lastError){
          console.warn("[DeepSeek] GET_DEEPSEEK_TOKEN error:",chrome.runtime.lastError.message);
          resolve(null);
          return;
        }
        resolve(response?.token||null);
      });
    }catch(e){
      console.warn("[DeepSeek] getDeepSeekToken failed:",e);
      resolve(null);
    }
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
var f=c(w());

/**
 * A() - Returns the DeepSeek token via cookie-based auth.
 * No email/password needed — reads from browser session.
 * Returns { token } on success or { error } on failure.
 */
async function A(){
  try{
    // 1. Try to get cached token from storage
    const stored=await f.default.storage.local.get(["deepseek-token"]);
    if(stored["deepseek-token"]){
      console.log("[DeepSeek] Using cached token");
      return{token:stored["deepseek-token"]}
    }

    // 2. Ask background SW to extract token from cookies/localStorage
    const token=await getDeepSeekToken();
    if(token){
      await f.default.storage.local.set({"deepseek-token":token});
      return{token}
    }

    return{error:"Not logged in. Please open https://chat.deepseek.com and log in, then come back."}
  }catch(r){
    return{error:r?.message||"An error occurred"}
  }
}

var s=c(h());

/**
 * DeepSeek status panel — replaces the old email/password login form.
 * Shows:
 *   - Green badge: logged in, how many cookies found
 *   - Orange badge: not logged in, with a link to chat.deepseek.com
 *   - A "Refresh Status" button
 *   - A "Disconnect" button (clears cached token from extension storage only)
 */
function D({onLoginStatusChange:e,callback:t}){
  const[status,setStatus]=(0,a.useState)(null); // null=loading, object=loaded
  const[checking,setChecking]=(0,a.useState)(false);

  const checkStatus=(0,a.useCallback)(async()=>{
    setChecking(true);
    try{
      const st=await getDeepSeekStatus();
      setStatus(st);
      // Also try to get/cache the token if logged in
      if(st.loggedIn){
        const tokenResult=await A();
        if(tokenResult.token){
          e&&e(true);
          t&&t();
        }else{
          // Has cookies but can't get token yet — still considered connected
          e&&e(true);
        }
      }else{
        e&&e(false);
      }
    }catch(err){
      console.error("[DeepSeek] checkStatus error:",err);
      setStatus({loggedIn:false,cookieCount:0,error:err?.message});
      e&&e(false);
    }finally{
      setChecking(false);
    }
  },[e,t]);

  // Check on mount
  (0,a.useEffect)(()=>{checkStatus();},[]);

  const handleDisconnect=(0,a.useCallback)(async()=>{
    await f.default.storage.local.remove(["deepseek-token","deepseek-login","deepseek-password"]);
    setStatus({loggedIn:false,cookieCount:0});
    e&&e(false);
  },[e]);

  // Loading state
  if(status===null){
    return(0,s.jsx)("div",{className:"flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400",
      children:[(0,s.jsx)(x,{style:"h-4 w-4"}),"Checking DeepSeek login status…"]})
  }

  if(status.loggedIn){
    return(0,s.jsxs)("div",{className:"flex flex-col gap-3 text-sm",children:[
      // Green status badge
      (0,s.jsxs)("div",{className:"flex items-center gap-2 rounded-md bg-green-50 dark:bg-green-900/30 px-3 py-2 text-green-700 dark:text-green-400",children:[
        (0,s.jsx)("span",{className:"inline-block h-2.5 w-2.5 rounded-full bg-green-500 flex-shrink-0"}),
        (0,s.jsxs)("span",{children:["Connected to DeepSeek",status.cookieCount>0?` (${status.cookieCount} cookies found)`:""]})
      ]}),
      (0,s.jsx)("p",{className:"text-xs text-gray-500 dark:text-gray-400",
        children:"Your DeepSeek browser session is being used automatically. No login required."}),
      // Actions row
      (0,s.jsxs)("div",{className:"flex items-center gap-2",children:[
        (0,s.jsx)("button",{type:"button",onClick:checkStatus,disabled:checking,
          className:"items-center rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-200 shadow-sm hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50",
          children:checking?(0,s.jsx)(x,{style:"h-3.5 w-3.5"}):"↻ Refresh"}),
        (0,s.jsx)("button",{type:"button",onClick:handleDisconnect,
          className:"items-center rounded-md border border-transparent bg-red-500 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-red-700",
          children:"Disconnect"})
      ]})
    ]})
  }

  // Not logged in
  return(0,s.jsxs)("div",{className:"flex flex-col gap-3 text-sm",children:[
    // Orange status badge
    (0,s.jsxs)("div",{className:"flex items-center gap-2 rounded-md bg-orange-50 dark:bg-orange-900/30 px-3 py-2 text-orange-700 dark:text-orange-400",children:[
      (0,s.jsx)("span",{className:"inline-block h-2.5 w-2.5 rounded-full bg-orange-400 flex-shrink-0"}),
      (0,s.jsx)("span",{children:"Not connected to DeepSeek"})
    ]}),
    (0,s.jsxs)("p",{className:"text-xs text-gray-500 dark:text-gray-400",children:[
      "To use DeepSeek, log in at ",
      (0,s.jsx)("a",{href:"https://chat.deepseek.com",target:"_blank",rel:"noopener noreferrer",
        className:"text-primary-600 underline hover:text-primary-800",
        children:"chat.deepseek.com"}),
      " in your browser. The extension will detect your session automatically."
    ]}),
    status.error&&(0,s.jsx)("p",{className:"text-xs text-red-500",children:status.error}),
    // Refresh button
    (0,s.jsx)("div",{className:"flex items-center justify-end",children:
      (0,s.jsx)("button",{type:"button",onClick:checkStatus,disabled:checking,
        className:"items-center rounded-md border border-transparent bg-primary-500 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 disabled:opacity-50",
        children:checking?(0,s.jsx)(x,{style:"flex h-5 w-5 items-center justify-center"}):"Check Login Status"})
    })
  ]})
}

var J=D;
export{R as a,J as b};
