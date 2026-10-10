import { Clock3 } from 'lucide-react'
import { useDownloadSchedule } from '../hooks/useDownloadSchedule'
import { Button } from './ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

export function ScheduleIndicator({ onClick }: { onClick: () => void }): React.JSX.Element | null {
  const { schedule, message } = useDownloadSchedule()
  if (!schedule?.enabled) return null

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="secondary"
            size="icon"
            aria-label="Download schedule enabled"
            className="text-primary"
            onClick={onClick}
          >
            <Clock3 />
          </Button>
        }
      />
      <TooltipContent>{message ?? 'Download schedule enabled'}</TooltipContent>
    </Tooltip>
  )
}
