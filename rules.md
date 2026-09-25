# DEFINITIONS

  behind:    same lane (top or bottom), any sublane, less far along the path

  ahead of:  same lane, any sublane, further along the path

  in line:   |stationA - stationB| < lineWindow

  collidable: would block under the collision rules below

  blocking:  a collidable unit that prevents this unit from moving to its

             target (forward on this sublane, or into a switch target)

             because it is in the way

  peel: ease forward or back until no longer inside another unit
  ease forward/back: move through units in the direction until it is not in line with that unit. 



# Movement

COLLISION ON / OFF

  halt, advance (order null), reform, charge: collision enabled

  fallback, retreat: collision disabled (pass through friendlies)



SPECIAL PASS-THROUGH (while collision would otherwise apply)

  cavalry (dragoon type or lancer variant) while charging:

    pass through all friendlies

  skirmisher OR officer while advancing (order null only):

    pass through non-skirmisher, non-officer friendlies

    (skirmishers/officers still collide with other skirmishers/officers)



IF halted:

  collision enabled

  do not move



IF advancing, reforming, or charging:

  collision enabled

  move forward (per order)

  IF blocked ahead on this sublane (collidable in same sublane within blockGap):

    look ahead to move around existing lines:

      consider every other sublane that has no collidable within blockGap

      of this unit's station (would not collide on entry)

      among those, pick the row whose next collidable ahead is furthest

      (empty ahead wins; closer rows win ties)

      commit that goal and step one adjacent sublane at a time toward it
      if the next step has a blockGap collidable:
        ease forward if this unit is ahead of that blocker
        ease back otherwise
        until clear, then enter — do not resume forward and thrash between rows
      stick to the committed goal while it stays a valid gap
    IF every sublane has a blockGap collidable at this station:
      pick an adjacent whose blockGap neighbor we are furthest behind
      ease (back or forward, same rule) until that adjacent opens, then switch
  never ease when the next step toward the goal is already clear



IF falling back or retreating:

  collision disabled



IF a unit ends a pass-through while overlapping a unit it now collides with:
  (examples: leave fall back/retreat; cavalry leave charge; skirmisher/officer
   leave advance while on another type)
  that unit peels until it no longer collides with any collidable
  (no lane switch for this peel):
    pick the overlapping collidable whose station is closest
    ease toward that unit (forward if they are ahead, back if behind)
    once chosen, keep easing that same direction until clear
    (do not flip when sandwiched between two units)
  it does not act on its order (halt, move, shoot, switch, reform join, etc.)
  until that peel is finished



Player / auto switch goals still move one adjacent sublane at a time

using the same clear-vs-ease rules for the next step only.



# Issuing orders

-	orders are issued to the touched unit and all units in line with it

-	click/touch: halt -> reform -> advance

-	swipe left: fallback, or advance if charging

-	swipe right: charge, or advance if halted

-	swipe up/down: switch to the row you stop swiping on

