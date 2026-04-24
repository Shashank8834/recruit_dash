export default function SummaryCard({ label, value, color = 'indigo', icon }) {
  const colors = {
    indigo: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300',
    green:  'bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-300',
    amber:  'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
    red:    'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  };

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <div className={`mb-3 inline-flex rounded-lg p-2.5 ${colors[color]}`}>
        {icon}
      </div>
      <p className="text-2xl font-bold text-gray-900 dark:text-white">{value}</p>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{label}</p>
    </div>
  );
}
