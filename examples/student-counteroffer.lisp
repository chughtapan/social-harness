(norm student-counteroffer
  :description "A student's agent, the client, requests a meeting with a professor's agent, the server, and gives availability. The server offers a slot. The client accepts that slot or gives alternative availability. The server books and confirms the accepted slot.")

(act request :by client :starts true :sets (open offer-due)
  (field topic :type string :min-length 1 :max-length 300
    :description "The subject to discuss.")
  (field availability :type string :min-length 1 :max-length 600
    :description "When the client can meet: dates, times and a timezone."))
(act propose :by server :when offer-due :clears offer-due :sets offered
  (field slot :type string :format date-time
    :description "The start of a meeting slot that fits the availability the client last stated.")
  (field length :type string :format duration))
(act reject-proposal :by client :when offered
  :clears offered :sets offer-due
  (field availability :type string :min-length 1 :max-length 600
    :description "Other times the client can meet: dates, times and a timezone."))
(act accept-proposal :by client :when offered
  :clears offered :sets selected
  (field slot :type string :format date-time)
  (relation equals slot (previous propose slot)))
(act confirm :by server :when selected :ends true
  (field slot :type string :format date-time)
  (relation equals slot (previous accept-proposal slot)))
(act failure :by server :when open :ends true
  (field reason :type string :min-length 1 :max-length 300
    :description "Why the request cannot be completed."))
(act not-understood :by (client server) :when open
  :clears (offered selected) :sets offer-due
  (field reason :type string :min-length 1
    :description "What was wrong with the act it answers or with the order of acts. It carries no counteroffer and no availability."))
