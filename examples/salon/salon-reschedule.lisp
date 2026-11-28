(norm salon-reschedule
  :description "A verified guest asks about moving their existing appointment. The salon can offer times or report no openings. The guest may keep the original or approve one offered time.")

(act request :by client :starts true :sets awaiting-options
  (field appointment :type integer :minimum 1)
  (field on :type string :format date)
  (field before-minute :type integer :minimum 0 :maximum 1440))

(act unavailable :by server :when awaiting-options :ends true
  (field appointment :type integer :minimum 1)
  (relation equals appointment (previous request appointment)))

(act offer :by server :when awaiting-options :clears awaiting-options :sets reviewing-slots
  (field appointment :type integer :minimum 1)
  (relation equals appointment (previous request appointment))
  (field slots :type list :min-items 1 :max-items 20 :format date-time)
  (field total-cents :type integer :minimum 0))

(act keep :by client :when reviewing-slots :ends true
  (field appointment :type integer :minimum 1)
  (relation equals appointment (previous offer appointment)))

(act select :by client :when reviewing-slots :clears reviewing-slots :sets move-authorized
  (field appointment :type integer :minimum 1)
  (relation equals appointment (previous offer appointment))
  (field slot :type string :format date-time)
  (relation member slot (previous offer slots)))

(act moved :by server :when move-authorized :ends true
  (field appointment :type integer :minimum 1)
  (relation equals appointment (previous select appointment))
  (field slot :type string :format date-time)
  (relation equals slot (previous select slot)))
