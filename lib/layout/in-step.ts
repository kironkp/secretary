// The one reading of "moved" (SPEC §2 and §3): two orders of the same
// sections, and the longest run of them that stands in step in both. What is
// outside that run moved. The validator rations movement by it, and the
// composition asks it where a section goes that a list lacks, so the two
// cannot disagree. When two runs are equally long it keeps the one that ends
// latest in `b`, then the one whose section before that stands latest, and
// so on. Pure.

/** The longest common subsequence of two key arrays: the sections in step. Those outside it moved. */
export function inStep(a: string[], b: string[]): Set<string> {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0)
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  const keep = new Set<string>();
  let i = a.length,
    j = b.length;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      keep.add(a[i - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
    else j--;
  }
  return keep;
}
