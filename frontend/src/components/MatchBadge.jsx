const STYLES = {
  STRONG:  'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  PARTIAL: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  WEAK:    'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300',
  NONE:    'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  UNKNOWN: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400',
};

export default function MatchBadge({ result }) {
  const style = STYLES[result] || STYLES.UNKNOWN;
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${style}`}>
      {result || 'UNKNOWN'}
    </span>
  );
}
