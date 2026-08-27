import { ChatTextIcon as ChatText, ImageSquareIcon as ImageSquare } from "@phosphor-icons/react";

import type { RunDetail } from "../../../shared/types.ts";
import { TextBlock } from "../TextBlock.tsx";

export function PromptStage({ run }: { run: RunDetail }) {
  return (
    <div className="grid h-full grid-rows-[1fr_1fr] gap-4 p-4 lg:grid-cols-2 lg:grid-rows-1">
      <TextBlock
        title="text spec"
        icon={<ChatText size={15} />}
        text={run.prompt}
        emptyLabel="no prompt recorded"
      />
      <TextBlock
        title="image prompt"
        icon={<ImageSquare size={15} />}
        text={run.imagePrompt}
        mono
        emptyLabel="no image prompt (draft phase may have been skipped)"
      />
    </div>
  );
}
