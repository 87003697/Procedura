import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CodeIcon as Code } from "@phosphor-icons/react";

import type { RunDetail } from "../../../shared/types.ts";
import { fade, useMotion } from "../../lib/motion.ts";
import { ScadPanel } from "../ScadPanel.tsx";
import { CustomizeStage } from "../stages/CustomizeStage.tsx";
import { Empty, Segmented } from "../ui.tsx";

type Mode = "source" | "parameters";

/** The program itself — read it, or move its parameters and watch it recompile. */
export function CodeView({ run, customize }: { run: RunDetail; customize: boolean }) {
  const scad = run.final?.scadPath ?? run.draft?.scadPath ?? null;
  const [mode, setMode] = useState<Mode>("source");
  const { v } = useMotion();

  if (!scad) {
    return (
      <Empty icon={<Code size={30} />} title="No source">
        This run produced no source program.
      </Empty>
    );
  }

  return (
    <div className="flex h-full flex-col px-6 pb-6">
      <div className="mb-3 flex items-center justify-between">
        <Segmented
          size="sm"
          value={mode}
          onChange={setMode}
          ariaLabel="Code view"
          options={[
            { value: "source", label: "Source" },
            { value: "parameters", label: "Parameters", disabled: !customize },
          ]}
        />
        {!customize && <span className="text-[11.5px] text-faint">Recompiling is unavailable on this server.</span>}
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-line bg-panel">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={mode} variants={v(fade)} initial="initial" animate="animate" exit="exit" className="absolute inset-0">
            {mode === "source" ? <ScadPanel path={scad} className="h-full" /> : <CustomizeStage run={run} />}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
