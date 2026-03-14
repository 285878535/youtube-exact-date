document.addEventListener('DOMContentLoaded', () => {
    const dateFormatSelect = document.getElementById('dateFormat');
    const showTimeCheckbox = document.getElementById('showTime');
    const saveBtn = document.getElementById('saveBtn');
    const statusDiv = document.getElementById('status');

    // Load saved settings
    chrome.storage.sync.get({
        dateFormat: 'YYYY-MM-DD',
        showTime: false
    }, (items) => {
        dateFormatSelect.value = items.dateFormat;
        showTimeCheckbox.checked = items.showTime;
    });

    // Save settings and reload active tab
    saveBtn.addEventListener('click', () => {
        const dateFormat = dateFormatSelect.value;
        const showTime = showTimeCheckbox.checked;

        chrome.storage.sync.set({
            dateFormat: dateFormat,
            showTime: showTime
        }, () => {
            statusDiv.textContent = '设置已保存！正在刷新页面...';
            setTimeout(() => {
                statusDiv.textContent = '';
                
                // Reload current youtube script
                chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
                    const activeTab = tabs?.[0];
                    if (activeTab?.url?.includes('youtube.com')) {
                        chrome.tabs.reload(activeTab.id);
                    }
                });
            }, 800);
        });
    });
});
