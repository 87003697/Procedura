import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";

import type { RunDetail } from "../../../shared/types.ts";
import { fade, useMotion } from "../../lib/motion.ts";
import { PromptStage } from "../stages/PromptStage.tsx";
import { FilesStage } from "../stages/FilesStage.tsx";
import { TrajectoryStage } from "../stages/TrajectoryStage.tsx";
import { CopyButton, Segmented, SlideOver } from "../ui.tsx";

type Tab = "prompt" | "files" | "events";

/** Everything a run knows about itself that is not the model: the prompt, the
 *  directory, the event log. Out of the way until asked for. */
export function DetailsPanel({ run, onClose }: { run: RunDetail; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("prompt");
  const { v } = useMotion();
  return (
    <SlideOver
      onClose={onClose}
      label="Run details"
      title={
        <span className="flex items-center gap-2">
          Details
          <span className="font-mono text-[11px] font-normal text-faint">{run.id}</span>
          <CopyButton text={run.id} label="" />
        </span>
      }
    >
      <div className="flex h-full flex-col">
        <div className="flex justify-center border-b border-line py-2.5">
          <Segmented
            size="sm"
            value={tab}
            onChange={setTab}
            ariaLabel="Details"
            options={[
              { value: "prompt", label: "Prompt" },
              { value: "files", label: "Files", disabled: run.files.length === 0 },
              { value: "events", label: "Events", disabled: run.trajectoryFiles.length === 0 },
            ]}
          />
        </div>
        <div className="relative min-h-0 flex-1">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={tab} variants={v(fade)} initial="initial" animate="animate" exit="exit" className="absolute inset-0">
              {tab === "prompt" && <PromptStage run={run} />}
              {tab === "files" && <FilesStage run={run} />}
              {tab === "events" && <TrajectoryStage run={run} />}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </SlideOver>
  );
}
