# 网页版屏幕共享 (Go + Pion SFU)

浏览器里共享自己的屏幕,同房间的人互相观看。1080P@60FPS,自建 SFU,无第三方服务。

## 架构

浏览器 `getDisplayMedia` 采集并编码 → WebRTC 推给服务器 → 服务器(Pion SFU)只转发 RTP 不转码 → 分发给同房间其他人。服务器是唯一 offerer,浏览器只 answer,天然无 glare。

- **按需订阅 (Selective Subscription)**: 服务器拦截视频流，仅向下发给主动点击“加入观看”的观众，未订阅者完全不耗费视频带宽。
- **观众席状态透传**: 服务器实时下发“谁在看谁”的追踪数据，主播可看到自己的围观者。
- **自动分配化名**: 加入房间自动分配 APEX 风格的随机昵称（如 `广东的红甲恶灵`），通过 IP 归属地 API 实现，如果 API 故障则保底显示为 `神秘的XXX`。
- 多房间:`?room=<房间号>`
- 鉴权:共享口令(token)

## 部署

### 1. 生成自签证书(pal 上执行一次)

`getDisplayMedia` 要求 secure context,必须 HTTPS。

```bash
cd ~/share && bash deploy/gen-cert.sh <樱花节点域名或公网IP>
```

### 2. 编译部署(Windows 开发机)

```bash
GOPROXY=https://goproxy.cn,direct go mod download
```

```powershell
.\deploy\build-deploy.ps1
```

交叉编译成 Linux 静态单二进制 → scp 到 pal → `pkill` 触发 systemd 重启(免 sudo 重部署)。

### 3. 安装 systemd 服务(pal 上执行一次,需 sudo 密码)

先改 `deploy/screenshare.service` 里的 `CHANGE_ME`(token)和 `CHANGE_TO_SAKURA_NODE_HOSTNAME`,然后:

```bash
sudo cp ~/share/deploy/screenshare.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now screenshare
```

### 4. SakuraFrp 隧道(两条)

| 类型 | 本地 | 远程端口 | 用途 |
|---|---|---|---|
| TCP | 192.168.5.4:8443 | 任意 | HTTPS + WSS |
| UDP | 192.168.5.4:42000 | **必须 42000** | 全部 WebRTC 媒体 |

UDP 隧道远程端口必须与本地同号:Pion `SetNAT1To1IPs` 只改写候选 IP、不改端口。选华南(广东电信同省)节点降低中转延迟,并确认节点支持 UDP。

## 使用

局域网:`https://192.168.5.4:8443` · 外网:`https://<节点域名>:<TCP远程端口>`

自签证书首次访问点「高级 → 继续前往」,之后仍是 secure context,共享功能正常。

按 `s` 或点「统计」看实时码率/帧率/编码器,`enc:` 显示软编(OpenH264/libvpx)说明该机器硬编没生效,1080P60 会掉帧。

## 带宽 (极致省流)

**得益于按需订阅机制，未点击观看的潜水观众完全不消耗任何视频带宽。**
每个**外网订阅者**消耗 1×码率(局域网观众走 LAN 不占樱花流量)，瓶颈 = min(家宽上行, 樱花套餐限速)。

- **潜水模式**: 100个人在房间挂机聊天，如果没人点观看 = **0 带宽消耗**。
- **单人围观**: 1 人共享 + 1 外网观众观看 = 1×码率 (8Mbps 档 = 8Mbps)
- **互相伤害**: 4 人互看所有人 = 每人消耗 3×下行 + 1×上行 = 满载运作

UI 提供三档 APEX 风格码率可选（黄金 3M、钻石 5M、猎杀 8M）。`limit: bandwidth` 说明带宽不够,下调档位。TWCC 反压兜底,超载时降质不崩。

## 已知限制

- Wayland 采集部分合成器限 30fps,建议共享单个窗口而非整个桌面
- macOS 需授予屏幕录制权限,且只能采集标签页音频
- 断线重连后共享不会自动恢复(`getDisplayMedia` 需要用户手势),按提示重新点「共享屏幕」
- 建议用 Chrome/Edge,H.264 硬编支持最好

## 后续可选升级

买域名 CNAME 到樱花节点 + `acme.sh --issue --dns` 拿 Let's Encrypt 证书,消除自签警告(改 `-cert/-key` 路径即可,无需改代码)。
