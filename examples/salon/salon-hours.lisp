(norm salon-hours
  :description "Ask for regular opening hours on one weekday or this week's dated schedule, in the salon's local time.")

(act ask-hours :by client :starts true :sets (open asked)
  (field weekday :type integer :minimum 1 :maximum 7))
(act open-hours :by server :when asked :ends true
  (field weekday :type integer :minimum 1 :maximum 7)
  (relation equals weekday (previous ask-hours weekday))
  (field opens :type integer :minimum 0 :maximum 1439)
  (field closes :type integer :minimum 1 :maximum 1440))
(act closed :by server :when asked :ends true)
(act ask-week :by client :starts true :sets (open week)
  (field week-of :type string :optional true :format date))
(act week-hours :by server :when week :ends true
  (field week-of :type string :format date)
  (field open-days :type list :min-items 0 :max-items 7
    (item :type record
      (field weekday :type integer :minimum 1 :maximum 7)
      (field opens :type integer :minimum 0 :maximum 1439)
      (field closes :type integer :minimum 1 :maximum 1440))))
(act unavailable :by server :when open :ends true)
(act withdraw :by client :when open :ends true)
