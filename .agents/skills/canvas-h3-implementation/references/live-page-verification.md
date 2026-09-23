# 活页面验证配方（browser_exec 接管用户授权 Chrome 后）

当 src 改了、HMR 应该推过、但用户看不到变化 → 用这套直接在用户那台画布页面上读 DOM 实测，**不靠用户截图**。

## 一次性确认：能否接管

1. 让用户在 Chrome 里打开 `chrome://inspect/#remote-debugging`，勾上"Allow remote debugging for this browser instance"，点 Allow。
2. 每次新 `browser_exec` 会话都会再弹一次 Allow（per-connection 授权，正常）。
3. `new_tab("http://127.0.0.1:3001/canvas/<id>")` 后 `wait_for_load()`，再 `time.sleep(2-3)` 等 HMR/组件挂载。
4. **快速 smoke**：`js("document.querySelectorAll('.minimax-canvas-workbench').length")` 返回 1 = 节点已渲染。

## 三个必查的事实

| 想验证 | JS 表达式 | 看什么 |
|---|---|---|
| 颜色/计算样式生效 | `js("getComputedStyle(document.querySelector('.minimax-edit-timeline'),'::after').backgroundColor")` | 应为 `rgb(59, 130, 246)`（项目蓝） |
| 指针位置跟手 | `js("getComputedStyle(document.querySelector('.minimax-edit-timeline'),'::after').left")` | 字符串如 `"853.5px"`；同步看 `playhead = seconds*50 + 52`（50px/s 刻度） |
| 点击落点不被遮挡 | `js("(function(){const r=el.getBoundingClientRect();return JSON.stringify({x:r.x+r.width*f,y:r.y+r.height/2})})()")` + `document.elementFromPoint(x,y)` | class 应是预期可点击元素，不是 `.minimax-pane-resize` 或 `.minimax-track-content` |

## 合成 PointerEvent 测试 click

`setPointerCapture` 对 `dispatchEvent(new PointerEvent(...))` 的假事件会抛 NotFoundError，截断后续 handler。两种绕法：

1. **try/catch 已经在源码里**（H3 当前 scrubber 写法）→ 直接 dispatch，正常测。
2. **源码没保护** → 用 CDP 真鼠标（harness 偶尔 5s 超时；超时则退而求其次直接读 `metadata.playhead` 验证函数是否执行）：
   ```python
   cdp('Input.dispatchMouseEvent', type='mousePressed', x=x, y=y, button='left', clickCount=1)
   cdp('Input.dispatchMouseEvent', type='mouseReleased', x=x, y=y, button='left', clickCount=1)
   ```

## 三个常见踩坑

- **画布节点带 zoom transform**（实测 ~0.282）：`getBoundingClientRect()` 给屏幕 px，`offsetLeft/Width/Top` 给本地 CSS px。混用必错（曾因此 scrubber 只 3px 高）。统一规则：定位用 `offset*`，屏幕尺寸量完除以 `wbr.width / wb.offsetWidth`。
- **ruler 横向滚动**：点击换算必须加 `scrollLeft`：`px = (clientX - rect.left)/scale + scroll`，否则滚出去的内容点不到。
- **HMR 后旧的组件实例还在**：测之前先 `js("location.reload()")` + 等 5s，否则可能拿到旧 React fiber。

## 测完必读的状态

```js
js("""JSON.stringify({
  brand: document.querySelector('.minimax-brand b')?.textContent,
  after: getComputedStyle(document.querySelector('.minimax-edit-timeline'),'::after').left,
})""")
```

`brand` 应形如 `"10.0s / 31s"`，`after` 形如 `"552px"`。两次相差 ≥0.5s 即视为指针真的跟着 click 移动。