(norm salon-handoff
  :description "A guest asks the front desk to help with an appointment reminder issue and receives the ticket number for that issue.")

(act request-handoff :by client :starts true :sets awaiting-ticket
  (field issue :type integer :minimum 1 :maximum 3))

(act handoff-confirmed :by server :when awaiting-ticket :ends true
  (field ticket :type integer :minimum 1)
  (field issue :type integer :minimum 1 :maximum 3)
  (relation equals issue (previous request-handoff issue)))
