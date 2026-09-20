from __future__ import annotations

import asyncio
import json
import re
import time
from dataclasses import dataclass
from typing import Any, AsyncGenerator

from app.agent.provider import 创建提供者, 规则引擎提供者, 模型回复, 流式增量, 逐块
from app.agent.tools import 工具注册表
from app.core.config import 读取设置


# 用于识别"只写引导词却不展开"的残缺答案
_不完整答案模式 = re.compile(
    r"(?:具体包括|以下几点|如下|核心能力|主要方面|主要技能|优势|内容|条目|项目)[：:]\s*$|…$|\.\.\.$|等$"
)


def _答案是否完整(答案: str) -> bool:
    return not _不完整答案模式.search(答案.strip())


@dataclass
class 步骤事件:
    类型: str
    数据: dict[str, Any]

    def sse(self) -> str:
        return f"data: {json.dumps({'type': self.类型, **self.数据}, ensure_ascii=False)}\n\n"


class Agent运行时:
    def __init__(self) -> None:
        self.设置 = 读取设置()
        self.提供者 = 创建提供者()
        # 远程 LLM 一旦失败（典型：账户余额不足 402 / 网络不可达）就记住，
        # 后续步骤直接走规则引擎，避免每步都重发必然失败的网络请求（单步最长 20s）。
        self._降级引擎: 规则引擎提供者 | None = None
        self._远程已失败 = False

    def _降级(self) -> 规则引擎提供者:
        if self._降级引擎 is None:
            self._降级引擎 = 规则引擎提供者()
        return self._降级引擎

    async def _取生成器(self, 问题: str, 对话历史: list[dict], 观察: list[str]):
        """拿到本次决策的增量生成器；远程不可用时直接用规则引擎。"""
        if self._远程已失败:
            return self._降级().流式决策(问题, 对话历史, 观察)
        try:
            return self.提供者.流式决策(问题, 对话历史, 观察)
        except Exception:
            self._远程已失败 = True
            return self._降级().流式决策(问题, 对话历史, 观察)

    async def _降级推送(
        self, 问题: str, 对话历史: list[dict], 观察: list[str], 已推送: set[str]
    ) -> AsyncGenerator[流式增量, None]:
        """规则引擎兜底：整段决策后，把还没吐过的部分按打字机节奏补上。"""
        try:
            回复 = await asyncio.wait_for(
                self._降级().决策(问题, 对话历史, 观察),
                timeout=self.设置.Agent单步超时秒,
            )
        except Exception:
            return
        if "thinking" not in 已推送 and 回复.思考:
            async for 块 in 逐块(回复.思考):
                yield 流式增量("thinking", 块)
        if "answer" not in 已推送 and 回复.完成 and 回复.答案:
            async for 块 in 逐块(回复.答案):
                yield 流式增量("answer", 块)
        yield 流式增量("final", "", 回复)

    @staticmethod
    async def _安全关闭(生成器) -> None:
        try:
            await 生成器.aclose()
        except Exception:
            pass

    async def 流式运行(
        self, 会话id: int, 问题: str, 历史: list[dict], 落盘
    ) -> AsyncGenerator[步骤事件, None]:
        """落盘: async callable(步骤, 思考, 工具, 输入, 观察, 阶段, 耗时) -> None"""
        观察: list[str] = []
        对话历史 = [*历史, {"role": "user", "content": 问题}]
        总步数 = 0
        yield 步骤事件("start", {"provider": self.提供者.名称, "max_steps": self.设置.Agent最大步数})

        for 步 in range(1, self.设置.Agent最大步数 + 1):
            开始 = time.perf_counter()
            回复: 模型回复 | None = None
            已推送: set[str] = set()

            # 一次决策 = 消费一个增量生成器：先把思考/答案片段转发给前端，
            # 最后拿到 definitive 的 模型回复 再决定是调用工具还是收尾。
            生成器 = None
            try:
                生成器 = await self._取生成器(问题, 对话历史, 观察)
                while True:
                    剩余 = self.设置.Agent单步超时秒 - (time.perf_counter() - 开始)
                    if 剩余 <= 0:
                        raise TimeoutError("单步超时")
                    try:
                        增量 = await asyncio.wait_for(生成器.__anext__(), timeout=剩余)
                    except StopAsyncIteration:
                        break
                    if 增量.类型 in ("thinking", "answer"):
                        已推送.add(增量.类型)
                        yield 步骤事件(
                            f"{增量.类型}_delta", {"delta": 增量.文本, "step": 步}
                        )
                        continue
                    回复 = 增量.回复
                    if 回复 is not None:
                        await self._安全关闭(生成器)
                        break
            except Exception as 错误:
                # 超时同样视为远程 LLM 不可用：改用规则引擎再试一次，仍失败才终止。
                # 避免把 402/网络异常等原始错误抛给用户。
                await self._安全关闭(生成器)
                self._远程已失败 = True
                降级回复: 模型回复 | None = None
                async for 增量 in self._降级推送(问题, 对话历史, 观察, 已推送):
                    if 增量.类型 == "final":
                        降级回复 = 增量.回复
                    else:
                        yield 步骤事件(
                            f"{增量.类型}_delta", {"delta": 增量.文本, "step": 步}
                        )
                if 降级回复 is None:
                    yield 步骤事件("error", {"message": f"第 {步} 步决策超时，已终止"})
                    await 落盘(步, "决策超时", None, None, "", "error", (time.perf_counter() - 开始) * 1000)
                    return
                回复 = 降级回复

            if 回复 is None:
                # 生成器既没给 final 也没抛错（异常上游才会这样），兜底再决策一次，避免 None 崩掉
                self._远程已失败 = True
                async for 增量 in self._降级推送(问题, 对话历史, 观察, 已推送):
                    if 增量.类型 == "final":
                        回复 = 增量.回复
                    else:
                        yield 步骤事件(f"{增量.类型}_delta", {"delta": 增量.文本, "step": 步})
                if 回复 is None:
                    yield 步骤事件("error", {"message": f"第 {步} 步未产出有效决策，已终止"})
                    await 落盘(步, "决策为空", None, None, "", "error", (time.perf_counter() - 开始) * 1000)
                    return

            if 回复.完成 or not 回复.动作:
                耗时 = round((time.perf_counter() - 开始) * 1000, 2)
                总步数 = 步
                # 兜底：若模型只写了"具体包括："等引导词却不展开，把最近一次工具观察追加进答案
                if 观察 and not _答案是否完整(回复.答案):
                    回复.答案 = f"{回复.答案.rstrip(' ：:\n')}\n\n{观察[-1]}"
                await 落盘(步, 回复.思考, None, None, 回复.答案, "finish", 耗时)
                yield 步骤事件("answer", {"answer": 回复.答案, "thought": 回复.思考, "step": 步})
                break

            工具名 = 回复.动作
            yield 步骤事件("thinking", {"thought": 回复.思考, "step": 步})
            yield 步骤事件("action", {"tool": 工具名, "input": 回复.动作输入, "step": 步})

            结果 = await 工具注册表.调用(工具名, 回复.动作输入)
            观察文本 = 结果.输出 if 结果.成功 else f"工具执行失败：{结果.错误}"
            引用 = 结果.数据.get("引用") if isinstance(结果.数据, dict) else None
            观察.append(f"[{工具名}] {观察文本}")
            耗时 = round((time.perf_counter() - 开始) * 1000, 2)

            await 落盘(步, 回复.思考, 工具名, 回复.动作输入, 观察文本, "act", 耗时)
            yield 步骤事件(
                "observation",
                {"tool": 工具名, "output": 观察文本, "citations": 引用 or [], "latency_ms": 结果.耗时毫秒, "step": 步},
            )
            总步数 = 步
        else:
            yield 步骤事件("answer", {"answer": "已达最大推理步数，未能得出结论。", "step": 总步数})

        yield 步骤事件("done", {"steps": 总步数})
