/* Клиент API «Змейки» */
(function () {
  'use strict';

  async function request(url, options) {
    const opts = Object.assign({ headers: { Accept: 'application/json' } }, options || {});
    if (opts.body) opts.headers['Content-Type'] = 'application/json';

    let response;
    try {
      response = await fetch(url, opts);
    } catch {
      throw new Error('Сервер недоступен. Проверьте соединение.');
    }

    let data = null;
    try {
      data = await response.json();
    } catch {
      /* пустой ответ */
    }

    if (!response.ok || !data || data.ok === false) {
      const message = (data && data.error && data.error.message) || 'Ошибка сервера (' + response.status + ')';
      const error = new Error(message);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  window.SnakeAPI = {
    leaderboard(limit) {
      return request('/api/leaderboard?limit=' + encodeURIComponent(limit || 10));
    },
    submitScore(payload) {
      return request('/api/scores', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
    },
    health() {
      return request('/api/health');
    }
  };
})();
