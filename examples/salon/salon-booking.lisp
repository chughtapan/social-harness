(norm salon-booking
  :description "Request one catalog service. The salon quotes one staff member's available times at one total in cents. The client selects a time at that total, then the salon confirms the booking or declines.")

(act request :by client :starts true :sets (open waiting)
  (field time-of-day :type string :min-length 1 :max-length 16 :optional true)
  (field compare :type boolean :optional true)
  (field ceiling-cents :type integer :minimum 0 :optional true)
  (field on :type string :format date :optional true)
  (field service :type integer :minimum 1))
(act offer :by server :when waiting :clears waiting :sets offered
  (field service :type integer :minimum 1)
  (relation equals service (previous request service))
  (field staff :type integer :minimum 1)
  (field slots :type list :min-items 1 :max-items 20 :format date-time)
  (field total-cents :type integer :minimum 0))
(act select :by client :when offered :clears offered :sets selected
  (field slot :type string :format date-time)
  (relation member slot (previous offer slots))
  (field total-cents :type integer :minimum 0)
  (relation equals total-cents (previous offer total-cents)))
(act booked :by server :when selected :ends true
  (field slot :type string :format date-time)
  (relation equals slot (previous select slot))
  (field total-cents :type integer :minimum 0)
  (relation equals total-cents (previous select total-cents)))
(act decline :by server :when open :ends true)
(act withdraw :by client :when (open waiting) :ends true)
(act decline-offer :by client :when offered :ends true)

(act alternatives :by server :when waiting :clears waiting :sets (offered options-quoted)
  (field service :type integer :minimum 1)
  (field choices :type list :min-items 1 :max-items 20
    (item :type record
      (field staff :type integer :minimum 1)
      (field total-cents :type integer :minimum 0)
      (field slot :type string :format date-time)))
  (relation equals service (previous (fact waiting) service)))

(act choose :by client :when options-quoted :clears (offered options-quoted) :sets accepted-option
  (field choice :type record
    (field staff :type integer :minimum 1)
    (field total-cents :type integer :minimum 0)
    (field slot :type string :format date-time))
  (relation member choice (previous (fact options-quoted) choices)))

(act confirmed :by server :when accepted-option :ends true
  (field choice :type record
    (field total-cents :type integer :minimum 0)
    (field staff :type integer :minimum 1)
    (field slot :type string :format date-time))
  (relation equals choice (previous (fact accepted-option) choice)))
