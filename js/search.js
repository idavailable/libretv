// 部分采集源（如豆瓣资源 dbzy5）在服务端禁用了关键词搜索，
// 请求会返回 {"code":1002,"msg":"Current API forbids keyword search."}。
// 此时改用「拉取列表页 + 本地按片名筛选」作为兜底方案。
// 注意：这类源的资源库动辄数千页，全量扫描不现实，因此只扫最近入库的若干页。
const LIST_FALLBACK_MAX_PAGES = 20;

async function searchByListPaging(apiBaseUrl, apiName, apiId, query) {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return [];

    const results = [];
    const seenIds = new Set();

    for (let page = 1; page <= LIST_FALLBACK_MAX_PAGES; page++) {
        try {
            const pageUrl = `${apiBaseUrl}?ac=list&pg=${page}`;

            const proxiedUrl = await window.ProxyAuth?.addAuthToProxyUrl ?
                await window.ProxyAuth.addAuthToProxyUrl(PROXY_URL + encodeURIComponent(pageUrl)) :
                PROXY_URL + encodeURIComponent(pageUrl);

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);

            const response = await fetch(proxiedUrl, {
                headers: API_CONFIG.search.headers,
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (!response.ok) break;

            const data = await response.json();
            if (!data || !Array.isArray(data.list) || data.list.length === 0) break;

            // ac=list 返回的是精简字段（无 vod_play_url），
            // 命中后需要按 vod_id 回查详情才能拿到播放链。
            const hits = data.list.filter(item =>
                (item.vod_name || '').toLowerCase().includes(keyword) ||
                (item.vod_en || '').toLowerCase().includes(keyword)
            );

            for (const hit of hits) {
                const vid = String(hit.vod_id || '');
                if (vid && seenIds.has(vid)) continue;
                if (vid) seenIds.add(vid);

                try {
                    const detailResults = await searchByAPIAndKeyWord(apiId, hit.vod_name, true);
                    // 详情回查命中后，只保留标题匹配的那一条，避免把同源其它结果混进来
                    const matched = (detailResults || []).filter(r =>
                        (r.vod_name || '').toLowerCase().includes(keyword)
                    );
                    if (matched.length > 0) {
                        results.push(...matched);
                    } else if (hit.vod_name) {
                        // 详情回查失败时，至少把列表里的基础信息返回，保证卡片可点
                        results.push({
                            ...hit,
                            source_name: apiName,
                            source_code: apiId
                        });
                    }
                } catch (e) {
                    console.warn(`${apiName} 回查「${hit.vod_name}」详情失败:`, e.message);
                }
            }

            // 已有结果则提前结束，避免无意义的翻页
            if (results.length > 0) break;
        } catch (error) {
            console.warn(`${apiName} 列表分页兜底第 ${page} 页失败:`, error.message);
            break;
        }
    }

    if (results.length > 0) {
        console.log(`${apiName} 通过列表分页兜底找到 ${results.length} 条结果`);
    }
    return results;
}

async function searchByAPIAndKeyWord(apiId, query, _isFallbackLookup = false) {
    try {
        let apiUrl, apiName, apiBaseUrl;
        
        // 处理自定义API
        if (apiId.startsWith('custom_')) {
            const customIndex = apiId.replace('custom_', '');
            const customApi = getCustomApiInfo(customIndex);
            if (!customApi) return [];
            
            apiBaseUrl = customApi.url;
            apiUrl = apiBaseUrl + API_CONFIG.search.path + encodeURIComponent(query);
            apiName = customApi.name;
        } else {
            // 内置API
            if (!API_SITES[apiId]) return [];
            apiBaseUrl = API_SITES[apiId].api;
            apiUrl = apiBaseUrl + API_CONFIG.search.path + encodeURIComponent(query);
            apiName = API_SITES[apiId].name;
        }
        
        // 添加超时处理
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        
        // 添加鉴权参数到代理URL
        const proxiedUrl = await window.ProxyAuth?.addAuthToProxyUrl ? 
            await window.ProxyAuth.addAuthToProxyUrl(PROXY_URL + encodeURIComponent(apiUrl)) :
            PROXY_URL + encodeURIComponent(apiUrl);
        
        const response = await fetch(proxiedUrl, {
            headers: API_CONFIG.search.headers,
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            return [];
        }
        
        const data = await response.json();

        // 上游明确拒绝了关键词搜索 → 走列表分页兜底
        // _isFallbackLookup 用来防止兜底逻辑再次触发自身造成无限递归
        if (data && data.code === 1002) {
            if (_isFallbackLookup) return [];
            console.warn(`${apiName} 已禁用关键词搜索（code 1002），改用列表分页兜底`);
            return await searchByListPaging(apiBaseUrl, apiName, apiId, query);
        }

        if (!data || !data.list || !Array.isArray(data.list) || data.list.length === 0) {
            return [];
        }
        
        // 处理第一页结果
        const results = data.list.map(item => ({
            ...item,
            source_name: apiName,
            source_code: apiId,
            api_url: apiId.startsWith('custom_') ? getCustomApiInfo(apiId.replace('custom_', ''))?.url : undefined
        }));
        
        // 获取总页数
        const pageCount = data.pagecount || 1;
        // 确定需要获取的额外页数 (最多获取maxPages页)
        const pagesToFetch = Math.min(pageCount - 1, API_CONFIG.search.maxPages - 1);
        
        // 如果有额外页数，获取更多页的结果
        if (pagesToFetch > 0) {
            const additionalPagePromises = [];
            
            for (let page = 2; page <= pagesToFetch + 1; page++) {
                // 构建分页URL
                const pageUrl = apiBaseUrl + API_CONFIG.search.pagePath
                    .replace('{query}', encodeURIComponent(query))
                    .replace('{page}', page);
                
                // 创建获取额外页的Promise
                const pagePromise = (async () => {
                    try {
                        const pageController = new AbortController();
                        const pageTimeoutId = setTimeout(() => pageController.abort(), 15000);
                        
                        // 添加鉴权参数到代理URL
                        const proxiedPageUrl = await window.ProxyAuth?.addAuthToProxyUrl ? 
                            await window.ProxyAuth.addAuthToProxyUrl(PROXY_URL + encodeURIComponent(pageUrl)) :
                            PROXY_URL + encodeURIComponent(pageUrl);
                        
                        const pageResponse = await fetch(proxiedPageUrl, {
                            headers: API_CONFIG.search.headers,
                            signal: pageController.signal
                        });
                        
                        clearTimeout(pageTimeoutId);
                        
                        if (!pageResponse.ok) return [];
                        
                        const pageData = await pageResponse.json();
                        
                        if (!pageData || !pageData.list || !Array.isArray(pageData.list)) return [];
                        
                        // 处理当前页结果
                        return pageData.list.map(item => ({
                            ...item,
                            source_name: apiName,
                            source_code: apiId,
                            api_url: apiId.startsWith('custom_') ? getCustomApiInfo(apiId.replace('custom_', ''))?.url : undefined
                        }));
                    } catch (error) {
                        console.warn(`API ${apiId} 第${page}页搜索失败:`, error);
                        return [];
                    }
                })();
                
                additionalPagePromises.push(pagePromise);
            }
            
            // 等待所有额外页的结果
            const additionalResults = await Promise.all(additionalPagePromises);
            
            // 合并所有页的结果
            additionalResults.forEach(pageResults => {
                if (pageResults.length > 0) {
                    results.push(...pageResults);
                }
            });
        }
        
        return results;
    } catch (error) {
        console.warn(`API ${apiId} 搜索失败:`, error);
        return [];
    }
}