(() => {
  window.__wechatStatsAssistant = {
    token: new URL(location.href).searchParams.get("token") || ""
  };
})();
