/*
 * Copyright (c) 2024 Justin Xing. All rights reserved.
 * Contact: justinxing001@gmail.com
 *
 * 概要：全局无样式覆盖，纯净回归原生纯文本日期显示。
 * 新增原生支持 Shorts 短视频页面的上传日期精准读取及动态拼接，无缝衔接且支持性能级卡片回收检测。
 * Summary: Globally replace relative times natively cleanly. Add dynamic upload date fetching for Shorts cards.
 */

(function () {
    'use strict';

    let currentSettings = {
        dateFormat: 'YYYY-MM-DD',
        showTime: false
    };

    function loadSettings(callback) {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
            chrome.storage.sync.get({
                dateFormat: 'YYYY-MM-DD',
                showTime: false
            }, (items) => {
                currentSettings = items;
                if (callback) callback();
            });
        } else {
            if (callback) callback();
        }
    }

    // 格式化功能，支持设置与时分秒
    function formatExactDate(date) {
        if (!(date instanceof Date) || isNaN(date)) return '';
        
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        
        let formatStr = currentSettings.dateFormat || 'YYYY-MM-DD';
        let result = formatStr.replace('YYYY', y).replace('MM', m).replace('DD', d);

        if (currentSettings.showTime) {
            const hh = String(date.getHours()).padStart(2, '0');
            const mm = String(date.getMinutes()).padStart(2, '0');
            const ss = String(date.getSeconds()).padStart(2, '0');
            result += ` ${hh}:${mm}:${ss}`;
        }
        
        return result;
    }

    const timeReg = /(\d+)\s*(秒|分|小时|天|周|个月|年|second|minute|hour|day|week|month|year)s?(?:前|\s*ago)/i;
    const specialReg = /(?:yesterday|昨天)/i;

    function estimateDateFromText(text) {
        if (!text) return null;
        const now = new Date();
        
        const match = text.match(timeReg);
        if (!match) {
            if (specialReg.test(text)) {
                now.setDate(now.getDate() - 1);
                return now;
            }
            return null;
        }

        const value = parseInt(match[1]);
        const unit = match[2].toLowerCase();

        switch (unit) {
            case '秒': case 'second': now.setSeconds(now.getSeconds() - value); break;
            case '分': case 'minute': now.setMinutes(now.getMinutes() - value); break;
            case '小时': case 'hour': now.setHours(now.getHours() - value); break;
            case '天': case 'day': now.setDate(now.getDate() - value); break;
            case '周': case 'week': now.setDate(now.getDate() - (value * 7)); break;
            case '个月': case 'month': now.setMonth(now.getMonth() - value); break;
            case '年': case 'year': now.setFullYear(now.getFullYear() - value); break;
        }
        return now;
    }

    // --- Shorts 获取引擎 (Shorts Dynamic Date Fetcher) ---
    
    const shortDateCache = new Map();
    const fetchingSet = new Set();
    const fetchQueue = [];
    let activeFetches = 0;
    const MAX_CONCURRENT_FETCHES = 3;

    function appendShortDate(span, exactDateStr) {
        const text = span.textContent;
        // 防抖：检测是否已经附加过文本了
        if (text.includes(exactDateStr) || text.includes(' • ')) return;
        if (text.includes('Premiering') || text.includes('LIVE')) return;

        span.textContent = text + ' • ' + exactDateStr;
    }

    async function processFetchQueue() {
        if (activeFetches >= MAX_CONCURRENT_FETCHES || fetchQueue.length === 0) return;

        activeFetches++;
        const { videoId, span } = fetchQueue.shift();

        try {
            const res = await fetch('/shorts/' + videoId, { credentials: 'same-origin' });
            if (res.ok) {
                const html = await res.text();
                // 解析隐藏在页面DOM源码中的真实上传时间元数据
                const metaMatch = html.match(/<meta\s+itemprop="datePublished"\s+content="([^"]+)"/i) 
                               || html.match(/<meta\s+itemprop="uploadDate"\s+content="([^"]+)"/i);
                
                let dateObj = null;
                if (metaMatch) {
                    dateObj = new Date(metaMatch[1]);
                } else {
                    const publishMatch = html.match(/"publishDate":"([^"]+)"/);
                    if (publishMatch) {
                        dateObj = new Date(publishMatch[1]);
                    }
                }

                if (dateObj && !isNaN(dateObj)) {
                    const exactDateStr = formatExactDate(dateObj);
                    shortDateCache.set(videoId, exactDateStr); // 缓存起来
                    
                    const reel = span.closest('ytd-reel-item-renderer, yt-lockup-view-model, ytd-rich-item-renderer, ytd-grid-video-renderer');
                    if (reel && reel.dataset.jxVideoId === videoId) {
                        appendShortDate(span, exactDateStr);
                    }
                }
            }
        } catch (e) {
            // 静默处理由于网络环境异常或并发导致的前端提取短路
        } finally {
            activeFetches--;
            processFetchQueue(); // Next job
        }
    }

    function queueFetchShortDate(videoId, span) {
        if (shortDateCache.has(videoId)) {
            appendShortDate(span, shortDateCache.get(videoId));
            return;
        }
        if (fetchingSet.has(videoId)) return; // 已经在列队中
        
        fetchingSet.add(videoId);
        fetchQueue.push({ videoId, span });
        processFetchQueue();
    }

    // 交叉观察器 (Intersection Observer) : 能够只在卡片曝光于当前屏幕时发起智能请求
    const shortObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const reel = entry.target;
                const videoId = reel.dataset.jxVideoId;
                const span = reel.querySelector('.jx-short-view-span');
                
                if (videoId && span) {
                    observer.unobserve(reel);
                    queueFetchShortDate(videoId, span);
                }
            }
        });
    }, { rootMargin: '300px' }); // 缓冲区提前300px缓冲


    // --- 核心扫描与替换系统 (Main Core) ---
    
    function scanAndReplace() {
        // 1. 获取播放页的最权威精确时间
        let exactWatchDateStr = null;
        const metaDate = document.querySelector('meta[itemprop="uploadDate"], meta[itemprop="datePublished"]');
        if (metaDate && metaDate.content) {
            const parsed = new Date(metaDate.content);
            if (!isNaN(parsed)) {
                exactWatchDateStr = formatExactDate(parsed);
            }
        }

        // 2. 传统全站文本扫描替换 (普通视频列表/播放页)
        // 过滤包含 jx-processed 以避免重复遍历无限循环
        const elements = document.querySelectorAll(`
            span:not([data-jx-processed="true"]),
            yt-formatted-string:not([data-jx-processed="true"])
        `);

        elements.forEach(node => {
            // 过滤仍包含子节点的span(防止污染带有嵌套结构的HTML组合)
            if (node.children.length > 0 && Array.from(node.children).some(c => c.tagName === 'SPAN')) return;
            
            const text = (node.textContent || "").trim();
            if (text.length === 0 || text.length > 60) return;

            if (timeReg.test(text) || specialReg.test(text)) {
                let exactDate = null;
                
                // 判断：当处于播放详情页，如果截获了最精确的上传时间就用最精确的
                if (exactWatchDateStr && node.closest('ytd-watch-metadata, #info-container')) {
                    exactDate = exactWatchDateStr;
                } else {
                    const estimated = estimateDateFromText(text); // 否则通过正则表达式逆向推演
                    if (estimated) {
                        exactDate = formatExactDate(estimated);
                    }
                }

                if (exactDate) {
                    // 原生替换逻辑：比如将 "3万观看 · 3周前" 变成 "3万观看 · 2024-03-14"
                    node.textContent = text.replace(timeReg, exactDate).replace(specialReg, exactDate);
                    node.dataset.jxProcessed = 'true';
                }
            }
        });

        // 3. Shorts 短视频支持与底层资源池循环检测机制 (Recycle View Handling)
        const reels = document.querySelectorAll('ytd-reel-item-renderer, yt-lockup-view-model, ytd-rich-item-renderer, ytd-grid-video-renderer');
        reels.forEach(reel => {
            const aTag = reel.querySelector('a[href*="/shorts/"]');
            if (!aTag) return;

            const match = aTag.getAttribute('href').match(/\/shorts\/([^?&#]+)/);
            if (!match) return;

            const videoId = match[1];

            // 判断: 如果它是一个尚未附着数据的全新 DOM 卡片，或者是被系统流式复用的 DOM 卡片
            if (reel.dataset.jxVideoId !== videoId) {
                reel.dataset.jxVideoId = videoId;
                
                // Shorts 的数据承载端位置
                // 动态查找到存放“次观看”的叶子节点
                const textNodes = Array.from(reel.querySelectorAll('span, yt-formatted-string, yt-core-attributed-string')).filter(el => {
                    const txt = (el.textContent || "").trim();
                    if (txt.length === 0 || txt.length > 40) return false;
                    const hasInnerTxtNode = el.querySelector('span, yt-formatted-string, yt-core-attributed-string');
                    return !hasInnerTxtNode && /观看|views?/i.test(txt);
                });
                
                if (textNodes.length === 0) return;
                const viewCountSpan = textNodes[0];

                // 先清理掉旧的残留标记，防止复用对象时出错
                const oldSpan = reel.querySelector('.jx-short-view-span');
                if (oldSpan && oldSpan !== viewCountSpan) oldSpan.classList.remove('jx-short-view-span');

                viewCountSpan.classList.add('jx-short-view-span'); 
                shortObserver.observe(reel); // 通知爬虫列队接管工作！
            }
        });
    }

    // SPA 网页无刷新 DOM 监听引擎
    let timer = null;
    const observer = new MutationObserver(() => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(scanAndReplace, 200); // 节流优化：仅当 DOM 停止变化后 200ms 高效运行！
    });

    // 引擎入口点
    function init() {
        loadSettings(() => {
            scanAndReplace();
            observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        });
    }

    // 应对 YouTube 无刷新切换频道的硬性触发
    window.addEventListener('yt-navigate-finish', () => {
        setTimeout(scanAndReplace, 400);
        setTimeout(scanAndReplace, 1500); 
    });

    setTimeout(init, 500);
})();
