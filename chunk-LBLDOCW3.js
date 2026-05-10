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

// Must go through background SW because chrome.cookies is only available there
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

var a=c(E()),m=c(w());var f=c(w());

async function A(e,t){
  try{
    if(!e||!t){
      let o=await f.default.storage.local.get({"deepseek-login":"","deepseek-password":""});
      e=o["deepseek-login"],t=o["deepseek-password"]
    }

    const cookieStr=await getDeepSeekCookies();
    console.log("[DeepSeek] cookies found:",cookieStr?"yes (length "+cookieStr.length+")":"none");

    const headers={
      "Content-Type":"application/json",
      "Accept":"application/json",
      "x-app-version":"20241129.1",
      "x-client-platform":"web",
      "x-client-locale":"en_US"
    };
    if(cookieStr)headers["Cookie"]=cookieStr;

    let r=await fetch(P.loginUrl,{
      method:"POST",
      headers,
      credentials:"omit",
      body:JSON.stringify({email:e,password:t,mobile:"",area_code:"",device_id:"",os:"web"})
    });

    let n;
    try{n=await safeJson(r)}
    catch(parseErr){return{error:"Server returned an unreadable response. Please try again."}}

    // Detect WAF/bot challenge: non-JSON HTML body
    if(n&&n.__rawHtml__!==undefined){
      return{error:"DeepSeek is blocking this request (bot protection).\n\nPlease open https://chat.deepseek.com in your browser, log in there first, then try again here."}
    }

    // Blank body — WAF challenge with empty response
    if(n===null){
      if(!cookieStr){
        return{error:"DeepSeek requires browser cookies to authenticate.\n\nPlease: 1) Open https://chat.deepseek.com in a tab, 2) Log in there, 3) Come back and try again here."}
      }
      return{error:`Login returned empty response (${r.status}). DeepSeek may be rate-limiting or blocking this request. Please wait a moment and try again.`}
    }

    if(!r.ok){
      return{error:n?.error||n?.detail?.message||n?.message||`Login failed (${r.status}). Please check your credentials.`}
    }

    if(r.ok&&n?.data?.user){
      let o=n.data.user.token;
      await f.default.storage.local.set({"deepseek-token":o,"deepseek-login":e,"deepseek-password":t});
      return{token:o}
    }else{
      console.warn("[DeepSeek] ok but unexpected response shape:",JSON.stringify(n).slice(0,300));
      return{error:n?.error||n?.message||`Unexpected response from DeepSeek (${r.status}). Raw: `+JSON.stringify(n).slice(0,150)}
    }
  }catch(r){
    return console.error("Login error",r),{error:r?.message||"An error occurred during login"}
  }
}

var s=c(h());

function D({onLoginStatusChange:e,callback:t}){let[r,n]=(0,a.useState)(""),[o,d]=(0,a.useState)(""),[u,y]=(0,a.useState)(!1),[k,b]=(0,a.useState)(null),[l,g]=(0,a.useState)(!1);return(0,a.useEffect)(()=>{(async()=>{let i=await m.default.storage.local.get({"deepseek-login":"","deepseek-password":""});i["deepseek-login"]&&i["deepseek-password"]?(n(i["deepseek-login"]),d(i["deepseek-password"]),g(!0),e&&e(!0)):e&&e(!1)})()},[e]),(0,s.jsxs)("div",{className:"flex flex-col gap-3 text-sm",children:[(0,s.jsxs)("div",{children:[(0,s.jsx)("label",{htmlFor:"username",className:"block text-sm font-medium leading-6 text-gray-900 dark:text-gray-200",children:"Email"}),(0,s.jsx)("div",{className:"mt-2",children:(0,s.jsx)("input",{type:"text",name:"username",id:"username",value:r,onChange:i=>n(i.target.value),disabled:l,required:!0,className:`block w-full rounded-md border-0 py-1.5 text-gray-900 shadow-sm 
              ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 
              focus:ring-inset focus:ring-primary-600 disabled:bg-gray-100 disabled:text-gray-500
              sm:text-sm sm:leading-6`})})]}),(0,s.jsxs)("div",{children:[(0,s.jsx)("label",{htmlFor:"password",className:"block text-sm font-medium leading-6 text-gray-900 dark:text-gray-200",children:"Password"}),(0,s.jsx)("div",{className:"mt-2",children:(0,s.jsx)("input",{type:"password",name:"password",id:"password",value:o,onChange:i=>d(i.target.value),disabled:l,required:!0,className:`block w-full rounded-md border-0 py-1.5 text-gray-900 shadow-sm
              ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2
              focus:ring-inset focus:ring-primary-600 disabled:bg-gray-100 disabled:text-gray-500
              sm:text-sm sm:leading-6`})})]}),k&&(0,s.jsx)("div",{className:"text-red-500 text-xs leading-snug whitespace-pre-line",children:k}),(0,s.jsxs)("div",{className:"flex items-center justify-end gap-2",children:[!l&&(0,s.jsx)("button",{type:"button",onClick:async()=>{if(l)return;y(!0),b(null);let i=await A(r,o);"token"in i?(await m.default.storage.local.set({"deepseek-login":r,"deepseek-password":o,"deepseek-token":i.token}),g(!0),e&&e(!0),t&&t()):b(i.error),y(!1)},disabled:u,className:`items-center rounded-md border border-transparent bg-primary-500
              px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-primary-700
              focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2
              disabled:cursor-not-allowed disabled:bg-primary-300 disabled:opacity-50`,children:u?(0,s.jsx)(x,{style:"flex h-5 w-5 items-center justify-center"}):"Login"}),l&&(0,s.jsx)("button",{type:"button",onClick:async()=>{await m.default.storage.local.remove(["deepseek-login","deepseek-password","deepseek-token"]),n(""),d(""),g(!1),e&&e(!1)},className:`items-center rounded-md border border-transparent bg-red-500
              px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-red-700
              focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2`,children:"Remove Account"})]})]})}var J=D;export{R as a,J as b};
