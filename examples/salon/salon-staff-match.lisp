(norm salon-staff-match
  :description "A first-time guest asks for a stylist who provides a service and speaks a language. The desk returns up to two matching public names and their new-client eligibility.")

(act find-staff :by client :starts true :sets search-received
  (field service :type integer :minimum 1)
  (field language :type string :min-length 1 :max-length 80))

(act staff-results :by server :when search-received :ends true
  (field service :type integer :minimum 1)
  (relation equals service (previous find-staff service))
  (field language :type string :min-length 1 :max-length 80)
  (relation equals language (previous find-staff language))
  (field matches :type list :min-items 0 :max-items 2
    (item :type record
      (field name :type string :min-length 1 :max-length 80)
      (field accepts-new :type boolean))))
