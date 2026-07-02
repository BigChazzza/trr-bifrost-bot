const SIGNATURE = '\n\n-BigChazzza Bot';

// Each entry: kills threshold -> message sent directly to that player.
// Thresholds must be in ascending order.
export const KILL_MILESTONES = [
  {
    kills: 30,
    message: `Woah! 30! Saves some kills for the rest of us!${SIGNATURE}`,
  },
  {
    kills: 40,
    message: `40 kills?!? Someone’s been eating their greens!${SIGNATURE}`,
  },
  {
    kills: 50,
    message: `50 kills?!? Now you’re showing off…${SIGNATURE}`,
  },
  {
    kills: 60,
    message: `60 souls… You’re on fire!${SIGNATURE}`,
  },
  {
    kills: 70,
    message: `70 kills?!? - Ring ring, it’s TRR recruitment on the phone…${SIGNATURE}`,
  },
  {
    kills: 80,
    message: `80 kills - Jesus Chris… it’s Jason Bourne…${SIGNATURE}`,
  },
  {
    kills: 90,
    message: `90 kills?!? Cronus bot has kicked in, checking system….${SIGNATURE}`,
  },
  {
    kills: 100,
    message: `100 kills?!? And there we have it…. The triple digits club! - Lifetime VIP awarded…. Joking but come back tomorrow.${SIGNATURE}`,
  },
];

/**
 * Returns the list of milestone objects that a player has just crossed,
 * in ascending order, given their previous notified milestone threshold
 * and their current kill delta.
 *
 * Example: prevNotified=20, currentKills=35 -> [{kills:30, message:'...'}]
 * Example: prevNotified=0,  currentKills=22 -> [{kills:10,...},{kills:20,...}]
 */
export function getMilestonesToNotify(prevNotifiedKills, currentKills) {
  return KILL_MILESTONES.filter(
    (m) => m.kills > prevNotifiedKills && m.kills <= currentKills
  );
}
