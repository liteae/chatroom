// 用户颜色分配与时间显示（房间/群聊共用）
const userColorMap = new Map();

function getRandomColor() {
  const colors = ['#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#1abc9c', '#3498db', '#9b59b6', '#e91e63', '#00bcd4', '#ff5722'];
  return colors[Math.floor(Math.random() * colors.length)];
}

function getUserColor(username) {
  if (userColorMap.has(username)) return userColorMap.get(username);
  const color = getRandomColor();
  userColorMap.set(username, color);
  return color;
}

function getTimeStr() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

module.exports = { getUserColor, getTimeStr };
